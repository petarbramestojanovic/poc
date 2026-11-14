import type { Db, Queryable } from '../../core/db.ts'
import type { DateWindow, IsoDate } from '../../core/dates.ts'
import { loadSql } from '../../core/sql-file.ts'
import { frequencyOf, type Frequency, type ReportWindow } from '../webhooks/periods.ts'

// Every statement the tick, send-now and preview run, one function each. Creating, changing and
// listing reports is admin.ts. SQL lives in ./sql/*.sql and is read at import time.
const sql = loadSql(import.meta.url, [
  'load_report',
  'load_due_reports',
  'update_next_run',
  'insert_delivery',
  'load_delivery_for_period',
  'requeue_delivery',
  'claim_next_delivery',
  'claim_delivery',
  'record_attempt',
] as const)

export interface EmailReportRecord {
  id: string
  companyId: string
  name: string
  kind: string
  /** null = every campaign of the company, including ones created later. */
  campaignIds: string[] | null
  recipients: string[]
  scheduleCron: string
  timezone: string
  frequency: Frequency
  /** As stored; the report's kind reads it (kinds/). */
  settings: unknown
  enabled: boolean
  nextRunAt: Date
}

export interface ReportRow {
  id: string
  company_id: string
  name: string
  kind: string
  campaign_ids: string[] | null
  recipients: string[]
  schedule_cron: string
  timezone: string
  report_window: ReportWindow
  settings: unknown
  enabled: boolean
  next_run_at: Date
}

export const toReport = (row: ReportRow): EmailReportRecord => ({
  id: row.id,
  companyId: row.company_id,
  name: row.name,
  kind: row.kind,
  campaignIds: row.campaign_ids,
  recipients: row.recipients,
  scheduleCron: row.schedule_cron,
  timezone: row.timezone,
  frequency: frequencyOf(row.report_window),
  settings: row.settings,
  enabled: row.enabled,
  nextRunAt: row.next_run_at,
})

export async function loadReport(q: Queryable, id: string): Promise<EmailReportRecord | undefined> {
  const rows = await q.query<ReportRow>(sql.load_report, [id])
  return rows[0] ? toReport(rows[0]) : undefined
}

export async function loadDueReports(
  q: Queryable,
  now: Date,
  limit: number,
): Promise<EmailReportRecord[]> {
  const rows = await q.query<ReportRow>(sql.load_due_reports, [now, limit])
  return rows.map(toReport)
}

export async function updateNextRun(q: Queryable, id: string, nextRunAt: Date): Promise<void> {
  await q.query(sql.update_next_run, [id, nextRunAt])
}

export type DeliveryTrigger = 'schedule' | 'manual'
export type DeliveryStatus = 'pending' | 'delivered' | 'failed'

export interface NewDelivery {
  id: string
  reportId: string
  period: DateWindow
  trigger: DeliveryTrigger
  document: string
  contentType: string
}

/** Inserts a delivery with the document it will attach; undefined when the period already has one. */
export async function insertDelivery(
  q: Queryable,
  delivery: NewDelivery,
): Promise<string | undefined> {
  const rows = await q.query<{ id: string }>(sql.insert_delivery, [
    delivery.id,
    delivery.reportId,
    delivery.period.from,
    delivery.period.to,
    delivery.trigger,
    delivery.document,
    delivery.contentType,
  ])
  return rows[0]?.id
}

export interface DeliveryRecord {
  id: string
  status: DeliveryStatus
  attempts: number
}

export async function loadDeliveryForPeriod(
  q: Queryable,
  reportId: string,
  period: DateWindow,
): Promise<DeliveryRecord | undefined> {
  const rows = await q.query<DeliveryRecord>(sql.load_delivery_for_period, [
    reportId,
    period.from,
    period.to,
  ])
  return rows[0]
}

/** Re-queues a pending or failed delivery with a rebuilt document; undefined if it was delivered. */
export async function requeueDelivery(
  q: Queryable,
  id: string,
  document: string,
  contentType: string,
): Promise<string | undefined> {
  const rows = await q.query<{ id: string }>(sql.requeue_delivery, [id, document, contentType])
  return rows[0]?.id
}

/** A delivery claimed for one attempt, with what the email needs. */
export interface DueDelivery {
  id: string
  reportId: string
  period: DateWindow
  /** This attempt's number (1 = the first), counted when the row was claimed. */
  attempt: number
  document: string
  contentType: string
  reportName: string
  /** The report's recipients as of the claim. */
  recipients: string[]
  timezone: string
}

interface DueDeliveryRow {
  id: string
  email_report_id: string
  period_start: IsoDate
  period_end: IsoDate
  attempts: number
  document: string
  content_type: string
  name: string
  recipients: string[]
  timezone: string
}

const toDueDelivery = (row: DueDeliveryRow): DueDelivery => ({
  id: row.id,
  reportId: row.email_report_id,
  period: { from: row.period_start, to: row.period_end },
  attempt: row.attempts,
  document: row.document,
  contentType: row.content_type,
  reportName: row.name,
  recipients: row.recipients,
  timezone: row.timezone,
})

/** Claims the oldest due delivery until `leaseUntil`; undefined when none is due. */
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
  status: DeliveryStatus
  nextAttemptAt: Date | null
  /** Why the attempt failed, without an address; null once delivered. */
  error: string | null
  /** Who the email went to; set only when delivered. */
  sentTo: readonly string[] | null
  provider: string | null
  providerMessageId: string | null
}

/** False when the row moved on while the attempt was in flight; nothing was written then. */
export async function recordAttempt(db: Db, attempt: AttemptRecord): Promise<boolean> {
  const rows = await db.query<{ id: string }>(sql.record_attempt, [
    attempt.id,
    attempt.at,
    attempt.status,
    attempt.nextAttemptAt,
    attempt.error,
    attempt.sentTo,
    attempt.provider,
    attempt.providerMessageId,
    attempt.attempt,
  ])
  return rows.length > 0
}
