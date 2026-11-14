import type { Logger } from '../log.ts'

// The contract between the modules that send email and the provider that delivers it. A module
// sees only `Mailer`: it never names a provider, never reads a key and never chooses the sender.
// A provider sees only `OutgoingMail`: a message the mailer has already checked.

/** What MAIL_PROVIDER may name. `memory` keeps messages in the process and sends nothing. */
export const MAIL_PROVIDER_NAMES = ['resend', 'memory'] as const
export type MailProviderName = (typeof MAIL_PROVIDER_NAMES)[number]

/** What a module asks the mailer to send. */
export interface MailMessage {
  readonly to: readonly string[]
  readonly subject: string
  /** Plain text. */
  readonly text: string
  readonly attachments?: readonly MailAttachment[]
  /**
   * The same key is sent at most once, where the provider supports it (Resend keeps a key for 24
   * hours). A retry of the same message passes the same key; a changed message needs a new one,
   * since Resend refuses a known key with a different message.
   */
  readonly idempotencyKey: string
}

export interface MailAttachment {
  /** The name the recipient sees, e.g. "tchibo-always-on_2026-11-14.csv". */
  readonly filename: string
  /** e.g. "text/csv; charset=utf-8". */
  readonly contentType: string
  /** The file as text, sent as UTF-8. */
  readonly content: string
}

export interface MailResult {
  readonly provider: MailProviderName
  /** The provider's id for the message, for finding it in the provider's dashboard. */
  readonly messageId: string
}

/** A checked message with the configured sender: what a provider receives. */
export interface OutgoingMail {
  /** "Name <address>" or "address". */
  readonly from: string
  readonly replyTo?: string
  readonly to: readonly string[]
  readonly subject: string
  readonly text: string
  readonly attachments: readonly MailAttachment[]
  readonly idempotencyKey: string
}

export interface MailContext {
  readonly signal?: AbortSignal | undefined
  readonly log: Logger
}

/**
 * One provider's adapter. It translates and nothing else: an accepted message is a MailResult,
 * a refusal is MailRejectedError (sending it again cannot help) and anything else that went wrong
 * is MailUnavailableError (sending it again with the same key is safe).
 */
export interface MailProvider {
  readonly name: MailProviderName
  send(mail: OutgoingMail, ctx: MailContext): Promise<MailResult>
}

/** What modules get. The sender comes from config, never from a caller. */
export interface Mailer {
  readonly provider: MailProviderName
  send(message: MailMessage, ctx: MailContext): Promise<MailResult>
}

export type MailProviderConfig =
  { readonly name: 'resend'; readonly apiKey: string } | { readonly name: 'memory' }

/** Email is on when this exists (MAIL_PROVIDER is set). */
export interface MailConfig {
  readonly provider: MailProviderConfig
  /** "Name <address>" or "address", already checked. */
  readonly from: string
  readonly replyTo?: string
}
