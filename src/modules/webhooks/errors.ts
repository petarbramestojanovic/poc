import { AppError } from '../../core/errors.ts'

// Webhook failures, with the status POST /webhooks/:id/send-now answers. Delivery failures of a
// client's endpoint are NOT errors here: they are outcomes recorded on the delivery row, retried
// by the ladder in deliver.ts. These are our own refusals.

export class WebhookError extends AppError {
  override readonly name: string = 'WebhookError'
  override readonly code: string = 'webhook_error'
}

export class WebhookNotFoundError extends WebhookError {
  override readonly name = 'WebhookNotFoundError'
  override readonly code = 'webhook_not_found'
  override readonly status = 404
}

export class WebhookDisabledError extends WebhookError {
  override readonly name = 'WebhookDisabledError'
  override readonly code = 'webhook_disabled'
  override readonly status = 409
}

/** The target is not a public HTTPS address. Checked before every attempt, not only at config time. */
export class BlockedTargetError extends WebhookError {
  override readonly name = 'BlockedTargetError'
  override readonly code = 'blocked_target'
  override readonly status = 422
}

/** app.webhook.schedule_cron does not parse; the row cannot be scheduled. */
export class InvalidScheduleError extends WebhookError {
  override readonly name = 'InvalidScheduleError'
  override readonly code = 'invalid_schedule'
  override readonly status = 422
}

/**
 * A webhook that could never work as configured: unknown company, a campaign of another one, an
 * unknown source, a csv webhook without the key its importer needs, a header we send ourselves.
 */
export class InvalidWebhookError extends WebhookError {
  override readonly name = 'InvalidWebhookError'
  override readonly code = 'invalid_webhook'
  override readonly status = 422
}

/** No campaign has a number in the period, so there is nothing to send (reports skip such periods). */
export class EmptyPeriodError extends WebhookError {
  override readonly name = 'EmptyPeriodError'
  override readonly code = 'empty_period'
  override readonly status = 409
}

/**
 * A delivery cannot be put on the wire as stored: a csv webhook without PUBLIC_BASE_URL has no
 * link to send, and a row queued before version 2 holds no rendered document. Recorded on the
 * delivery as a failed attempt, like a client's 500, and never thrown out of a tick.
 */
export class ExportUnavailableError extends WebhookError {
  override readonly name = 'ExportUnavailableError'
  override readonly code = 'export_unavailable'
  override readonly status = 500
}

/**
 * A column that cannot be computed as written: its formula does not parse, names a variable that
 * does not exist, or uses a metric the webhook's source does not measure. The message says which
 * column and, for a syntax error, at which character.
 */
export class InvalidFormulaError extends WebhookError {
  override readonly name = 'InvalidFormulaError'
  override readonly code = 'invalid_formula'
  override readonly status = 422
}
