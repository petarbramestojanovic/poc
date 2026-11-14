import { createHash } from 'node:crypto'
import type { DateWindow } from '../../core/dates.ts'
import type { MailAttachment, MailMessage } from '../../core/mail/types.ts'

// What an email report looks like in an inbox: subject, plain text and the attachment's name. Pure,
// and built at every attempt from the stored document and the report as it is then, so a recipient
// list fixed after a refusal is used by the next attempt.

/** The name of a period: one day, or "first to last". */
export function periodLabel(period: DateWindow): string {
  return period.from === period.to ? period.from : `${period.from} to ${period.to}`
}

const MAX_SLUG_CHARS = 60

/** "Tchibo Always-on" → "tchibo-always-on": letters and digits only, accents dropped. */
export function slug(name: string): string {
  const plain = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, '')
  return plain === '' ? 'report' : plain
}

export function attachmentName(name: string, period: DateWindow, extension: string): string {
  const days = period.from === period.to ? period.from : `${period.from}_${period.to}`
  return `${slug(name)}_${days}.${extension}`
}

/** The extension a stored document's content type gets in its file name. */
export function extensionOf(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase()
  if (type === 'text/csv') return 'csv'
  if (type === 'application/json') return 'json'
  return 'txt'
}

export interface EmailSubjectOf {
  name: string
  timezone: string
}

/** The email for one delivery, without its idempotency key (idempotencyKeyFor). */
export function emailFor(
  report: EmailSubjectOf,
  recipients: readonly string[],
  period: DateWindow,
  document: string,
  contentType: string,
): Omit<MailMessage, 'idempotencyKey'> & { attachments: MailAttachment[] } {
  const label = periodLabel(period)
  return {
    to: recipients,
    subject: `${report.name}, ${label}`,
    text: [
      `Attached is the report "${report.name}" for ${label} (${report.timezone}).`,
      '',
      'This email is sent automatically.',
    ].join('\n'),
    attachments: [
      {
        filename: attachmentName(report.name, period, extensionOf(contentType)),
        contentType,
        content: document,
      },
    ],
  }
}

/**
 * The delivery id and a hash of everything in the email. A retry of an unchanged email carries the
 * same key, so a provider that keeps keys (Resend, 24 h) sends it once even if an earlier attempt's
 * answer was lost. A changed email (send-now rebuilt the document, the recipients or the name were
 * edited) gets a new key: Resend refuses a known key with a different message.
 */
export function idempotencyKeyFor(
  deliveryId: string,
  email: Omit<MailMessage, 'idempotencyKey'>,
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([email.to, email.subject, email.text, email.attachments ?? []]))
    .digest('hex')
    .slice(0, 16)
  return `${deliveryId}:${hash}`
}
