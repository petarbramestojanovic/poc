import type { IsoDate } from '../../core/dates.ts'
import { mergeRows, type MergeWarning } from '../sync/merge.ts'
import type { CanonicalDailyRow, MetricId } from '../sync/types.ts'
import { CLICKS_VARIABLE, PRICE_VARIABLE, type CompiledFields } from './fields.ts'
import { evaluate, fromNumber, parseDecimal, toRoundedNumber, type Fraction } from './formula.ts'

// Pure: the rows of one report, from what build.ts read. A row is one campaign on one day of the
// webhook's source. A campaign's languages and creatives are merged into it by the catalog
// (mergeRows: sums add, weighted averages weigh, the never-summed per-day scalars are kept only
// when they agree). A day without a single stored row has no report row: it is skipped, never
// filled with zeros.

/** What one cell holds: the date and the name, a fixed text, or a formula's number (null = none). */
export type CellValue = string | number | null

/** The cells of one row, in the order of CompiledFields.names. */
export type ReportRow = readonly CellValue[]

/** One analytics.advanced_analytics row of the source, for one language and creative. */
export interface MetricsRecord {
  campaignId: string
  campaign: string
  /** app.campaign.price as exact text; null when not known. */
  price: string | null
  date: IsoDate
  language: string
  campaignTag: string
  /** Only what the source measured. Absent = not measured, never 0. */
  metrics: Partial<Record<MetricId, number>>
}

/** Non-internal CTA clicks of one campaign on one day, all languages and creatives together. */
export interface ClicksRecord {
  campaignId: string
  campaign: string
  price: string | null
  date: IsoDate
  /** Exact integer text. */
  clicks: string
}

interface Group {
  campaignId: string
  campaign: string
  price: string | null
  date: IsoDate
  rows: CanonicalDailyRow[]
  clicks: Fraction | null
}

export function assembleRows(
  fields: CompiledFields,
  metrics: readonly MetricsRecord[],
  clicks: readonly ClicksRecord[],
  warn: MergeWarning = () => undefined,
): ReportRow[] {
  const groups = new Map<string, Group>()
  const groupOf = (record: {
    campaignId: string
    campaign: string
    price: string | null
    date: IsoDate
  }) => {
    const key = JSON.stringify([record.campaignId, record.date])
    let group = groups.get(key)
    if (!group) {
      group = {
        campaignId: record.campaignId,
        campaign: record.campaign,
        price: record.price,
        date: record.date,
        rows: [],
        clicks: null,
      }
      groups.set(key, group)
    }
    return group
  }

  for (const record of metrics) {
    // One key for every language and creative, so mergeRows folds them into one row.
    groupOf(record).rows.push({
      date: record.date,
      language: '',
      campaignTag: '',
      metrics: record.metrics,
      pageViews: [],
      ctaClicks: [],
      unmapped: new Map(),
    })
  }
  for (const record of clicks) groupOf(record).clicks = parseDecimal(record.clicks)

  return [...groups.values()].sort(byDateThenCampaign).map((group) => {
    const merged =
      mergeRows(group.rows, (message) => {
        warn(`${group.campaign}: ${message}`)
      })[0]?.metrics ?? {}
    const price = group.price === null ? null : parseDecimal(group.price)

    const lookup = (name: string): Fraction | null => {
      if (name === PRICE_VARIABLE) return price
      if (name === CLICKS_VARIABLE) return group.clicks
      const value = Object.hasOwn(merged, name) ? merged[name as MetricId] : undefined
      return typeof value === 'number' ? fromNumber(value) : null
    }

    return [
      group.date,
      group.campaign,
      ...fields.columns.map((column): CellValue => {
        if (column.kind === 'text') return column.value
        const value = evaluate(column.expr, lookup)
        return value === null ? null : toRoundedNumber(value, column.decimals)
      }),
    ]
  })
}

/** Day by day; within a day by campaign name, then id so two campaigns of one name stay apart. */
function byDateThenCampaign(a: Group, b: Group): number {
  return (
    compare(a.date, b.date) ||
    compare(a.campaign, b.campaign) ||
    compare(a.campaignId, b.campaignId)
  )
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
