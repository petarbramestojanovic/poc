import { randomUUID } from 'node:crypto'
import type { DateWindow } from '../../core/dates.ts'
import type { RunTracker } from '../sync/engine.ts'
import { buildReport, renderReport } from './build.ts'
import { deliverOnce, leaseUntil } from './deliver.ts'
import { EmptyPeriodError, WebhookDisabledError, WebhookNotFoundError } from './errors.ts'
import { readStoredFields } from './fields.ts'
import type { Format } from './payload.ts'
import { reportPeriod } from './periods.ts'
import * as repo from './repo.ts'
import type { WebhookDeps } from './scheduler.ts'

// POST /webhooks/:id/send-now: an out-of-schedule delivery of any range of days, in the webhook's
// own format — to test a new endpoint, re-send a period whose attempts ran out, or send a period
// again (RFC-002 §15.3). POST /webhooks/:id/preview: the document such a delivery would carry,
// built the same way and stored nowhere, to check a column list and its formulas before a client
// sees them. Neither waits for incomplete data: a person asked for this period now.
//
// What happens depends on the period's latest delivery:
//   pending or failed  re-queued under its own id with a rebuilt document: the client never
//                      confirmed that id, so it is still the one to dedupe on;
//   delivered          a NEW delivery with a new id (migration 0008): the client already took the
//                      old id and would rightly drop a repeat of it, and the delivered record stays;
//   none               a new delivery.
// A period without rows is refused, as the schedule would skip it.

export interface SendDeps extends WebhookDeps {
  /** In-flight deliveries; app.close() waits for them. */
  tracker?: RunTracker
}

export interface SendNowRequest {
  webhookId: string
  /** Defaults to the webhook's own frequency, as of now. */
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

  const fields = readStoredFields(webhook.payloadFields)
  const period = request.period ?? reportPeriod(webhook.frequency, webhook.timezone, now)
  const deliveryId = await deps.db.withTransaction(async (tx) => {
    const report = await buildReport(tx, webhook, period, fields, deps.log)
    if (report.rows.length === 0) {
      throw new EmptyPeriodError(
        `no campaign of webhook ${webhook.id} has a number in ${period.from}..${period.to}`,
      )
    }

    const latest = await repo.loadDeliveryForPeriod(tx, webhook.id, period)
    if (latest && latest.status !== 'delivered') {
      const requeued = await repo.requeueDelivery(
        tx,
        latest.id,
        renderReport(webhook, period, report, latest.id, now),
      )
      // Delivered by an attempt in flight since the read: send the period again, as below.
      if (requeued !== undefined) return requeued
    }

    const id = randomUUID()
    const document = renderReport(webhook, period, report, id, now)
    // A manual row never conflicts (insert_delivery.sql), so the insert always lands.
    const inserted = await repo.insertDelivery(tx, id, webhook.id, period, 'manual', document)
    if (inserted === undefined) throw new Error(`manual delivery ${id} was not inserted`)
    return inserted
  })

  const log = deps.log.child({ webhookId: webhook.id, deliveryId })
  log.info({ period }, 'webhook delivery queued by hand')

  if (request.deliverNow !== false) {
    attemptInBackground({ ...deps, log }, deliveryId)
  }
  return { deliveryId, period }
}

export interface PreviewRequest {
  webhookId: string
  /** Defaults to the webhook's own frequency, as of now. */
  period?: DateWindow
}

export interface Preview {
  format: Format
  period: DateWindow
  rowCount: number
  /** The exact text a delivery would store: the JSON body (delivery_id null) or the CSV file. */
  document: string
}

/**
 * The document a delivery of this period would carry. Nothing is stored and nothing is sent; a
 * disabled webhook can be previewed, so a column list can be checked first. An empty period
 * previews as an empty document, though the schedule would send nothing.
 */
export async function previewPayload(deps: SendDeps, request: PreviewRequest): Promise<Preview> {
  const now = (deps.now ?? (() => new Date()))()
  const webhook = await repo.loadWebhook(deps.db, request.webhookId)
  if (!webhook) throw new WebhookNotFoundError(`webhook ${request.webhookId} does not exist`)

  const fields = readStoredFields(webhook.payloadFields)
  const period = request.period ?? reportPeriod(webhook.frequency, webhook.timezone, now)
  const report = await buildReport(deps.db, webhook, period, fields, deps.log)
  return {
    format: webhook.format,
    period,
    rowCount: report.rows.length,
    document: renderReport(webhook, period, report, null, now),
  }
}

/**
 * Tries once, right away, so an operator testing an endpoint sees the result in seconds instead of
 * at the next tick. A failure here is an ordinary attempt: it is recorded on the row and the tick
 * picks up the retry. It claims the row like a tick does, so the two never send it at once.
 */
function attemptInBackground(deps: SendDeps, deliveryId: string): void {
  const attempt = (async () => {
    const now = (deps.now ?? (() => new Date()))()
    const delivery = await repo.claimDelivery(deps.db, deliveryId, now, leaseUntil(now))
    // Already claimed by a tick, or no longer pending: that attempt, or a later tick, sends it.
    if (delivery) await deliverOnce(deps, delivery)
  })().catch((error: unknown) => {
    deps.log.error({ err: error, deliveryId }, 'immediate webhook delivery failed')
  })
  if (deps.tracker) void deps.tracker.track(attempt)
}
