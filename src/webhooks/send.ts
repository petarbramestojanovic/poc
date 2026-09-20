import type { DateWindow } from '../dates.ts'
import type { RunTracker } from '../sync/engine.ts'
import { deliverOnce } from './deliver.ts'
import { AlreadyDeliveredError, WebhookDisabledError, WebhookNotFoundError } from './errors.ts'
import { reportPeriod } from './periods.ts'
import * as repo from './repo.ts'
import type { WebhookDeps } from './scheduler.ts'

// POST /webhooks/:id/send-now: an out-of-schedule delivery, for testing a new endpoint and for
// re-sending a period whose attempts ran out (RFC-002 §15.3).
//
// The (webhook, period) row is the idempotency record, so a re-send keeps the delivery id it had
// and only rebuilds the body — a client that already has that id can still dedupe. A period that
// went out successfully is never overwritten: that would erase the delivered record.

export interface SendDeps extends WebhookDeps {
  /** In-flight deliveries; app.close() waits for them. */
  tracker?: RunTracker
}

export interface SendNowRequest {
  webhookId: string
  /** Defaults to the webhook's own report window, as of now. */
  period?: DateWindow
  /** False makes the route only enqueue, leaving the delivery to the next tick (tests use it). */
  deliverNow?: boolean
}

export interface SendNowResult {
  deliveryId: string
  period: DateWindow
}

export async function sendNow(deps: SendDeps, request: SendNowRequest): Promise<SendNowResult> {
  const now = (deps.now ?? (() => new Date()))()
  const webhook = await repo.loadWebhook(deps.db, request.webhookId)
  if (!webhook) throw new WebhookNotFoundError(`webhook ${request.webhookId} does not exist`)
  if (!webhook.enabled) throw new WebhookDisabledError(`webhook ${webhook.id} is disabled`)

  const period = request.period ?? reportPeriod(webhook.reportWindow, webhook.timezone, now)
  const deliveryId = await deps.db.withTransaction(async (tx) => {
    const existing = await repo.loadDeliveryForPeriod(tx, webhook.id, period)
    if (existing) {
      if (existing.status === 'delivered') throw alreadyDelivered(webhook.id, period)
      const requeued = await repo.requeueDelivery(tx, existing.id)
      if (requeued === undefined) throw alreadyDelivered(webhook.id, period)
      return requeued
    }

    const inserted = await repo.insertDelivery(tx, webhook.id, period, 'manual')
    if (inserted !== undefined) return inserted

    // A scheduled tick created the same period between the read and the insert: adopt its row.
    const raced = await repo.loadDeliveryForPeriod(tx, webhook.id, period)
    if (!raced || raced.status === 'delivered') throw alreadyDelivered(webhook.id, period)
    return raced.id
  })

  const log = deps.log.child({ webhookId: webhook.id, deliveryId })
  log.info({ period }, 'webhook delivery queued by hand')

  if (request.deliverNow !== false) {
    attemptInBackground({ ...deps, log }, deliveryId)
  }
  return { deliveryId, period }
}

function alreadyDelivered(webhookId: string, period: DateWindow): AlreadyDeliveredError {
  return new AlreadyDeliveredError(
    `webhook ${webhookId} already delivered ${period.from}..${period.to}`,
  )
}

/**
 * Tries once, right away, so an operator testing an endpoint sees the result in seconds instead of
 * at the next tick. A failure here is an ordinary attempt: it is recorded on the row and the tick
 * picks up the retry.
 */
function attemptInBackground(deps: SendDeps, deliveryId: string): void {
  const attempt = (async () => {
    const delivery = await repo.loadDelivery(deps.db, deliveryId)
    // Already taken by a tick, or already delivered: nothing to do.
    if (delivery) await deliverOnce(deps, delivery)
  })().catch((error: unknown) => {
    deps.log.error({ err: error, deliveryId }, 'immediate webhook delivery failed')
  })
  if (deps.tracker) void deps.tracker.track(attempt)
}
