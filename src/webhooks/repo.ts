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
  'load_due_deliveries',
  'load_delivery',
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
}

export interface DeliveryRecord {
  id: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
}

/** A delivery waiting to go out, with everything one attempt needs. */
export interface DueDelivery {
  id: string
  webhookId: string
  period: DateWindow
  attempts: number
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

/** Inserts the delivery and its payload; undefined when the period already has a row. */
export async function insertDelivery(
  q: Queryable,
  webhookId: string,
  period: DateWindow,
  trigger: DeliveryTrigger,
): Promise<string | undefined> {
  const rows = await q.query<{ id: string }>(sql.insert_delivery, [
    webhookId,
    period.from,
    period.to,
    trigger,
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
export async function requeueDelivery(q: Queryable, id: string): Promise<string | undefined> {
  const rows = await q.query<{ id: string }>(sql.requeue_delivery, [id])
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
  attempts: row.attempts,
  payload: row.payload,
  url: row.url,
  secret: row.secret,
})

/** One pending delivery by id; undefined once it is delivered or failed. */
export async function loadDelivery(db: Db, id: string): Promise<DueDelivery | undefined> {
  const rows = await db.query<DueDeliveryRow>(sql.load_delivery, [id])
  return rows[0] ? toDueDelivery(rows[0]) : undefined
}

export async function loadDueDeliveries(db: Db, now: Date, limit: number): Promise<DueDelivery[]> {
  const rows = await db.query<DueDeliveryRow>(sql.load_due_deliveries, [now, limit])
  return rows.map(toDueDelivery)
}

export interface AttemptRecord {
  id: string
  at: Date
  status: 'pending' | 'delivered' | 'failed'
  nextAttemptAt: Date | null
  responseCode: number | null
  excerpt: string | null
}

export async function recordAttempt(db: Db, attempt: AttemptRecord): Promise<void> {
  await db.query(sql.record_attempt, [
    attempt.id,
    attempt.at,
    attempt.status,
    attempt.nextAttemptAt,
    attempt.responseCode,
    attempt.excerpt,
  ])
}
