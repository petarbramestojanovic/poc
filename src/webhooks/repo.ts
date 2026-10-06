import type { Db, Queryable } from '../db.ts'
import type { DateWindow, IsoDate } from '../dates.ts'
import { loadSql } from '../sql-file.ts'
import type { ReportWindow } from './periods.ts'

// Every webhook statement, one function each. SQL lives in ./sql/*.sql and is read at import time.
const sql = loadSql(import.meta.url, [
  'load_webhook',
  'load_due_webhooks',
  'update_next_run',
  'insert_delivery',
  'load_delivery_for_period',
  'requeue_delivery',
  'claim_next_delivery',
  'claim_delivery',
  'record_attempt',
] as const)

/** A configured target. `secret` signs the body and must never reach a log or an error message. */
export interface WebhookRecord {
  id: string
  name: string
  url: string
  secret: string
  scheduleCron: string
  timezone: string
  reportWindow: ReportWindow
  enabled: boolean
  nextRunAt: Date
  includeCreatives: boolean
  /** app.webhook.payload_fields as stored; fields.ts reads it (readStoredFields). */
  payloadFields: unknown
}

export interface DeliveryRecord {
  id: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
}

/** A delivery claimed for one attempt, with everything that attempt needs. */
export interface DueDelivery {
  id: string
  webhookId: string
  period: DateWindow
  /** This attempt's number (1 = the first), counted when the row was claimed. */
  attempt: number
  payload: unknown
  url: string
  secret: string
}

export type DeliveryTrigger = 'schedule' | 'manual'

interface WebhookRow {
  id: string
  name: string
  url: string
  secret: string
  schedule_cron: string
  timezone: string
  report_window: ReportWindow
  enabled: boolean
  next_run_at: Date
  include_creatives: boolean
  payload_fields: unknown
}

const toWebhook = (row: WebhookRow): WebhookRecord => ({
  id: row.id,
  name: row.name,
  url: row.url,
  secret: row.secret,
  scheduleCron: row.schedule_cron,
  timezone: row.timezone,
  reportWindow: row.report_window,
  enabled: row.enabled,
  nextRunAt: row.next_run_at,
  includeCreatives: row.include_creatives,
  payloadFields: row.payload_fields,
})

export async function loadWebhook(q: Queryable, id: string): Promise<WebhookRecord | undefined> {
  const rows = await q.query<WebhookRow>(sql.load_webhook, [id])
  return rows[0] ? toWebhook(rows[0]) : undefined
}

export async function loadDueWebhooks(
  q: Queryable,
  now: Date,
  limit: number,
): Promise<WebhookRecord[]> {
  const rows = await q.query<WebhookRow>(sql.load_due_webhooks, [now, limit])
  return rows.map(toWebhook)
}

export async function updateNextRun(q: Queryable, id: string, nextRunAt: Date): Promise<void> {
  await q.query(sql.update_next_run, [id, nextRunAt])
}

/**
 * Inserts the delivery with the body it will send (build.ts), its id stamped in; undefined when
 * the period already has a row.
 */
export async function insertDelivery(
  q: Queryable,
  webhookId: string,
  period: DateWindow,
  trigger: DeliveryTrigger,
  payload: unknown,
): Promise<string | undefined> {
  const rows = await q.query<{ id: string }>(sql.insert_delivery, [
    webhookId,
    period.from,
    period.to,
    trigger,
    JSON.stringify(payload),
  ])
  return rows[0]?.id
}

export async function loadDeliveryForPeriod(
  q: Queryable,
  webhookId: string,
  period: DateWindow,
): Promise<DeliveryRecord | undefined> {
  const rows = await q.query<DeliveryRecord>(sql.load_delivery_for_period, [
    webhookId,
    period.from,
    period.to,
  ])
  return rows[0]
}

/** Re-queues a pending or failed delivery with a rebuilt payload; undefined if it was delivered. */
export async function requeueDelivery(
  q: Queryable,
  id: string,
  payload: unknown,
): Promise<string | undefined> {
  const rows = await q.query<{ id: string }>(sql.requeue_delivery, [id, JSON.stringify(payload)])
  return rows[0]?.id
}

interface DueDeliveryRow {
  id: string
  webhook_id: string
  period_start: IsoDate
  period_end: IsoDate
  attempts: number
  payload: unknown
  url: string
  secret: string
}

const toDueDelivery = (row: DueDeliveryRow): DueDelivery => ({
  id: row.id,
  webhookId: row.webhook_id,
  period: { from: row.period_start, to: row.period_end },
  attempt: row.attempts,
  payload: row.payload,
  url: row.url,
  secret: row.secret,
})

/**
 * Claims the oldest due delivery for one attempt until `leaseUntil`; undefined when none is due.
 * A claimed row is invisible to every other claimer while the attempt is in flight.
 */
export async function claimNextDelivery(
  db: Db,
  now: Date,
  leaseUntil: Date,
): Promise<DueDelivery | undefined> {
  const rows = await db.query<DueDeliveryRow>(sql.claim_next_delivery, [now, leaseUntil])
  return rows[0] ? toDueDelivery(rows[0]) : undefined
}

/** Claims one delivery by id; undefined when it is not pending, not due, or already in flight. */
export async function claimDelivery(
  db: Db,
  id: string,
  now: Date,
  leaseUntil: Date,
): Promise<DueDelivery | undefined> {
  const rows = await db.query<DueDeliveryRow>(sql.claim_delivery, [id, now, leaseUntil])
  return rows[0] ? toDueDelivery(rows[0]) : undefined
}

export interface AttemptRecord {
  id: string
  /** The attempt's number from its claim: the row must still carry it for the record to land. */
  attempt: number
  at: Date
  status: 'pending' | 'delivered' | 'failed'
  nextAttemptAt: Date | null
  responseCode: number | null
  excerpt: string | null
}

/** False when the row moved on while the attempt was in flight; nothing was written then. */
export async function recordAttempt(db: Db, attempt: AttemptRecord): Promise<boolean> {
  const rows = await db.query<{ id: string }>(sql.record_attempt, [
    attempt.id,
    attempt.at,
    attempt.status,
    attempt.nextAttemptAt,
    attempt.responseCode,
    attempt.excerpt,
    attempt.attempt,
  ])
  return rows.length > 0
}
