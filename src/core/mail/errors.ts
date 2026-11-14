import { AppError } from '../errors.ts'
import { scrubAddresses } from './address.ts'
import type { MailProviderName } from './types.ts'

// Every way sending an email can fail, by what the caller should do about it. A caller that keeps
// a delivery record (email reports) records MailRejectedError and MailUnavailableError as attempt
// outcomes; only a programming error or an abort escapes as something else.

const MAX_MESSAGE_CHARS = 300

export class MailError extends AppError {
  override readonly name: string = 'MailError'
  override readonly code: string = 'mail_error'
}

/** MAIL_PROVIDER is not set, so email is off in this process. */
export class MailNotConfiguredError extends MailError {
  override readonly name = 'MailNotConfiguredError'
  override readonly code = 'mail_not_configured'
  override readonly status = 422
  constructor() {
    super('Email is off: MAIL_PROVIDER is not set')
  }
}

/** The mailer's own refusal: a message that could never be sent as written. No provider saw it. */
export class InvalidMailError extends MailError {
  override readonly name = 'InvalidMailError'
  override readonly code = 'invalid_mail'
  override readonly status = 422
  constructor(message: string) {
    super(scrubAddresses(message))
  }
}

export interface ProviderFailure {
  readonly provider: MailProviderName
  /** The provider's HTTP status, when it answered. */
  readonly providerStatus?: number
  /** The provider's own error name, e.g. Resend's "validation_error". */
  readonly providerCode?: string
}

/**
 * The provider answered and refused the message: a bad address, an unverified sender domain, a
 * wrong or revoked key. Sending the same message again gives the same answer.
 */
export class MailRejectedError extends MailError {
  override readonly name = 'MailRejectedError'
  override readonly code = 'mail_rejected'
  override readonly status = 502
  override readonly retryable = false
  readonly provider: MailProviderName
  readonly providerStatus: number | undefined
  readonly providerCode: string | undefined
  constructor(failure: ProviderFailure, message: string) {
    super(scrubAddresses(message).slice(0, MAX_MESSAGE_CHARS))
    this.provider = failure.provider
    this.providerStatus = failure.providerStatus
    this.providerCode = failure.providerCode
  }
}

/**
 * The message may or may not have gone out: the provider was unreachable, timed out, asked us to
 * slow down (429) or failed itself (5xx). Sending it again with the same idempotency key is safe.
 */
export class MailUnavailableError extends MailError {
  override readonly name = 'MailUnavailableError'
  override readonly code = 'mail_unavailable'
  override readonly status = 503
  override readonly retryable = true
  readonly provider: MailProviderName
  readonly providerStatus: number | undefined
  readonly providerCode: string | undefined
  constructor(failure: ProviderFailure, message: string, options?: ErrorOptions) {
    super(scrubAddresses(message).slice(0, MAX_MESSAGE_CHARS), options)
    this.provider = failure.provider
    this.providerStatus = failure.providerStatus
    this.providerCode = failure.providerCode
  }
}
