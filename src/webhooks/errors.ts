import { AppError } from '../errors.ts'

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

/** The period already went out. Re-queueing would overwrite the delivered record. */
export class AlreadyDeliveredError extends WebhookError {
  override readonly name = 'AlreadyDeliveredError'
  override readonly code = 'already_delivered'
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
