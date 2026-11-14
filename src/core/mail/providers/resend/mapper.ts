import { isRetryableStatus } from '../../../http/HttpClient.ts'
import { MailRejectedError, MailUnavailableError } from '../../errors.ts'
import type { MailResult, OutgoingMail } from '../../types.ts'
import { resendErrorSchema, resendSentSchema } from './schema.ts'

// Pure translation between our message and Resend's REST API (no I/O): the request body, the
// headers, and the answer as a result or one of the two mail errors.

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails'

/**
 * Resend refuses a request without a User-Agent (403). A generic name: the header reaches a third
 * party and says nothing about who runs this service.
 */
export const RESEND_USER_AGENT = 'report-mailer/1.0'

export interface ResendAttachment {
  filename: string
  /** Base64 of the file's bytes. */
  content: string
  content_type: string
}

export interface ResendEmailBody {
  from: string
  to: string[]
  subject: string
  text: string
  reply_to?: string
  attachments?: ResendAttachment[]
}

export function toResendBody(mail: OutgoingMail): ResendEmailBody {
  return {
    from: mail.from,
    to: [...mail.to],
    subject: mail.subject,
    text: mail.text,
    ...(mail.replyTo === undefined ? {} : { reply_to: mail.replyTo }),
    ...(mail.attachments.length === 0
      ? {}
      : {
          attachments: mail.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: Buffer.from(attachment.content, 'utf8').toString('base64'),
            content_type: attachment.contentType,
          })),
        }),
  }
}

export function toResendHeaders(apiKey: string, mail: OutgoingMail): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'idempotency-key': mail.idempotencyKey,
    'user-agent': RESEND_USER_AGENT,
  }
}

/** Resend's 409 for a key whose first request is still running: "safe to retry this request later". */
const CONCURRENT_KEY = 'concurrent_idempotent_requests'

/**
 * A 2xx with an id is accepted. 408, 429 and 5xx (rate limit, daily quota, Resend down) and a 409
 * for a key still in flight are unavailable: the same message with the same key may be sent again.
 * Every other status is a refusal (a bad key, an unverified domain, a recipient the test sender may
 * not reach, a key reused with a different message).
 */
export function readResendAnswer(
  status: number,
  body: unknown,
): MailResult | MailRejectedError | MailUnavailableError {
  if (status >= 200 && status < 300) {
    const sent = resendSentSchema.safeParse(body)
    if (sent.success) return { provider: 'resend', messageId: sent.data.id }
    return new MailUnavailableError(
      { provider: 'resend', providerStatus: status },
      `Resend answered HTTP ${status} without a message id`,
    )
  }

  const parsed = resendErrorSchema.safeParse(body)
  const name = parsed.success ? parsed.data.name : undefined
  const detail = parsed.success ? parsed.data.message : undefined
  const failure = {
    provider: 'resend' as const,
    providerStatus: status,
    ...(name === undefined ? {} : { providerCode: name }),
  }
  const summary = `HTTP ${status}${name === undefined ? '' : ` ${name}`}${detail === undefined ? '' : `: ${detail}`}`

  if (isRetryableStatus(status) || (status === 409 && name === CONCURRENT_KEY)) {
    return new MailUnavailableError(failure, `Resend could not take the message now (${summary})`)
  }
  return new MailRejectedError(failure, `Resend refused the message (${summary})`)
}
