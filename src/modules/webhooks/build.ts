import type { Queryable } from '../../core/db.ts'
import type { DateWindow } from '../../core/dates.ts'
import type { Logger } from '../../core/log.ts'
import { loadSql } from '../../core/sql-file.ts'
import { METRIC_IDS, type MetricId } from '../sync/types.ts'
import type { CompiledFields } from './fields.ts'
import { renderDocument, type Format } from './payload.ts'
import type { Frequency } from './periods.ts'
import { assembleRows, type MetricsRecord, type ReportRow } from './rows.ts'

// The one place a report is built: the tick's enqueue, send-now and preview all call buildReport,
// so a preview shows exactly what a delivery would store and send. Postgres reads the stored rows
// of the webhook's one source; rows.ts merges them into one row per campaign and day and computes
// the columns; payload.ts renders the document.

const sql = loadSql(import.meta.url, [
  'report_metrics',
  'report_clicks',
  'report_readiness',
] as const)

/** Which campaigns a webhook reports on, and how it delivers. */
export interface ReportTarget {
  id: string
  companyId: string
  /** null = every campaign of the company, including ones created later. */
  campaignIds: readonly string[] | null
  timezone: string
  frequency: Frequency
  format: Format
}

export interface Report {
  /** Column names in delivery order, `Date` and `Campaign` first. */
  names: readonly string[]
  rows: readonly ReportRow[]
}

type MetricsRow = {
  campaign_id: string
  campaign: string
  price: string | null
  events_date: string
  language: string
  campaign_tag: string
} & Record<MetricId, string | null>

interface ClicksRow {
  campaign_id: string
  campaign: string
  price: string | null
  events_date: string
  clicks: string
}

/** The rows of one webhook for one period. Empty when no campaign has a number in it. */
export async function buildReport(
  q: Queryable,
  target: ReportTarget,
  period: DateWindow,
  fields: CompiledFields,
  log?: Logger,
): Promise<Report> {
  const params = [target.companyId, target.campaignIds, fields.source, period.from, period.to]
  // One after the other: inside a transaction every statement shares one connection anyway.
  const metrics = await q.query<MetricsRow>(sql.report_metrics, params)
  const clicks = fields.usesClicks ? await q.query<ClicksRow>(sql.report_clicks, params) : []

  const rows = assembleRows(
    fields,
    metrics.map(toMetricsRecord),
    clicks.map((row) => ({
      campaignId: row.campaign_id,
      campaign: row.campaign,
      price: row.price,
      date: row.events_date,
      clicks: row.clicks,
    })),
    (message) => log?.warn({ webhookId: target.id, period }, message),
  )
  return { names: fields.names, rows }
}

/** bigint and numeric arrive as text; every metric is read back by its name, never by position. */
function toMetricsRecord(row: MetricsRow): MetricsRecord {
  const metrics: Partial<Record<MetricId, number>> = {}
  for (const id of METRIC_IDS) {
    const value = row[id]
    // NULL = not measured by the source: absent, never 0.
    if (value !== null) metrics[id] = Number(value)
  }
  return {
    campaignId: row.campaign_id,
    campaign: row.campaign,
    price: row.price,
    date: row.events_date,
    language: row.language,
    campaignTag: row.campaign_tag,
    metrics,
  }
}

/** The document a delivery of this report stores and sends; deliveryId null in a preview. */
export function renderReport(
  target: ReportTarget,
  period: DateWindow,
  report: Report,
  deliveryId: string | null,
  generatedAt: Date,
): string {
  return renderDocument(
    target.format,
    { deliveryId, generatedAt, period, timezone: target.timezone, frequency: target.frequency },
    report.names,
    report.rows,
  )
}

/**
 * The names of the campaigns whose source data does not yet cover the period: a scheduled report
 * waits while this is not empty (scheduler.ts).
 */
export async function incompleteCampaigns(
  q: Queryable,
  target: ReportTarget,
  source: string,
  period: DateWindow,
): Promise<string[]> {
  const rows = await q.query<{ name: string }>(sql.report_readiness, [
    target.companyId,
    target.campaignIds,
    source,
    period.from,
    period.to,
  ])
  return rows.map((row) => row.name)
}
