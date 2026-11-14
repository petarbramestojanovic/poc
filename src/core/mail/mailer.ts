import type { HttpClient } from '../http/HttpClient.ts'
import { formatSender, isEmailAddress, parseSender } from './address.ts'
import { InvalidMailError } from './errors.ts'
import { createMailProvider } from './providers/index.ts'
import type {
  MailAttachment,
  MailConfig,
  Mailer,
  MailMessage,
  MailProvider,
  OutgoingMail,
} from './types.ts'

// The only thing a module imports to send email. It holds the rules every provider shares: the
// sender comes from config, addresses and sizes are checked here, and a message that passes is
// one every provider we compared would accept. The provider behind it is a config choice.

/**
 * The whole message, attachments counted as base64 as they travel. 10 MB is the lowest cap of the
 * providers compared (Postmark; Resend and Amazon SES allow 40 MB), so a message that passes today
 * passes on any of them.
 */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024
/** Resend's limit for `to`. */
export const MAX_RECIPIENTS = 50
const MAX_SUBJECT_CHARS = 250
const MAX_ATTACHMENTS = 10
const MAX_FILENAME_CHARS = 200
/** Printable ASCII without spaces, 1–256 characters: Resend's limit, and safe in any header. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const FILENAME = /^[^\\/"\u0000-\u001f\u007f]+$/
const CONTENT_TYPE =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/i

export interface SenderSettings {
  readonly from: string
  readonly replyTo?: string | undefined
}

/** Builds the configured provider (MAIL_PROVIDER) behind the shared rules. */
export function createMailer(config: MailConfig, deps: { http: HttpClient }): Mailer {
  return mailerFor(createMailProvider(config.provider, deps), config)
}

/** The shared rules around any provider; tests pass the memory provider. */
export function mailerFor(provider: MailProvider, settings: SenderSettings): Mailer {
  const sender = parseSender(settings.from)
  if (sender === undefined)
    throw new InvalidMailError('The sender is not "address" or "Name <address>"')
  if (settings.replyTo !== undefined && !isEmailAddress(settings.replyTo)) {
    throw new InvalidMailError('The reply-to address is not an email address')
  }
  const from = formatSender(sender)
  const replyTo = settings.replyTo

  return {
    provider: provider.name,
    async send(message, ctx) {
      ctx.signal?.throwIfAborted()
      const mail = checkMessage(message, from, replyTo)
      const result = await provider.send(mail, ctx)
      ctx.log.debug(
        {
          mail: {
            provider: result.provider,
            messageId: result.messageId,
            recipients: mail.to.length,
            attachments: mail.attachments.length,
          },
        },
        'mail accepted',
      )
      return result
    },
  }
}

/** Throws InvalidMailError naming the first rule a message breaks. Never quotes an address. */
export function checkMessage(message: MailMessage, from: string, replyTo?: string): OutgoingMail {
  const to = [...message.to]
  if (to.length === 0) throw new InvalidMailError('A message needs at least one recipient')
  if (to.length > MAX_RECIPIENTS) {
    throw new InvalidMailError(
      `A message has at most ${MAX_RECIPIENTS} recipients, not ${to.length}`,
    )
  }
  const seen = new Set<string>()
  for (const [index, address] of to.entries()) {
    if (!isEmailAddress(address)) {
      throw new InvalidMailError(`Recipient ${index + 1} is not an email address`)
    }
    const key = address.toLowerCase()
    if (seen.has(key)) throw new InvalidMailError(`Recipient ${index + 1} is listed twice`)
    seen.add(key)
  }

  if (message.subject.trim() === '') throw new InvalidMailError('The subject is empty')
  if (message.subject.length > MAX_SUBJECT_CHARS) {
    throw new InvalidMailError(`The subject is longer than ${MAX_SUBJECT_CHARS} characters`)
  }
  if (CONTROL.test(message.subject)) {
    throw new InvalidMailError('The subject contains a line break or another control character')
  }
  if (!IDEMPOTENCY_KEY.test(message.idempotencyKey)) {
    throw new InvalidMailError(
      'The idempotency key must be 1–256 printable ASCII characters without spaces',
    )
  }

  const attachments = [...(message.attachments ?? [])]
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new InvalidMailError(`A message has at most ${MAX_ATTACHMENTS} attachments`)
  }
  for (const [index, attachment] of attachments.entries()) checkAttachment(attachment, index)

  const mail: OutgoingMail = {
    from,
    ...(replyTo === undefined ? {} : { replyTo }),
    to,
    subject: message.subject,
    text: message.text,
    attachments,
    idempotencyKey: message.idempotencyKey,
  }
  const bytes = messageBytes(mail)
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new InvalidMailError(
      `The message is ${bytes} bytes with its attachments encoded, over the ${MAX_MESSAGE_BYTES}-byte limit`,
    )
  }
  return mail
}

function checkAttachment(attachment: MailAttachment, index: number): void {
  const { filename } = attachment
  if (
    filename.length > MAX_FILENAME_CHARS ||
    !FILENAME.test(filename) ||
    filename.trim() !== filename ||
    filename === '.' ||
    filename === '..'
  ) {
    throw new InvalidMailError(
      `Attachment ${index + 1} needs a file name of at most ${MAX_FILENAME_CHARS} characters without slashes, quotes or control characters`,
    )
  }
  if (!CONTENT_TYPE.test(attachment.contentType)) {
    throw new InvalidMailError(`Attachment ${index + 1} has no usable content type`)
  }
}

/** The size a message travels at: text as UTF-8, attachments as base64. */
export function messageBytes(mail: OutgoingMail): number {
  let bytes = Buffer.byteLength(mail.subject) + Buffer.byteLength(mail.text)
  for (const attachment of mail.attachments) {
    bytes += 4 * Math.ceil(Buffer.byteLength(attachment.content) / 3)
    bytes += Buffer.byteLength(attachment.filename)
  }
  return bytes
}
