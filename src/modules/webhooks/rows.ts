import type { IsoDate } from '../../core/dates.ts'
import { mergeRows, type MergeWarning } from '../sync/merge.ts'
import type { CanonicalDailyRow, MetricId } from '../sync/types.ts'
import {
  CLICKS_VARIABLE,
  PRICE_VARIABLE,
  type CompiledFields,
  type CompiledRowSet,
} from './fields.ts'
import { evaluate, fromNumber, parseDecimal, toRoundedNumber, type Fraction } from './formula.ts'

// Pure: the rows of one report, from what build.ts read. Each row set makes its own rows from its
// own source: at campaign level one per campaign and day with the campaign's languages and
// creatives merged by the catalog (mergeRows: sums add, weighted averages weigh, the never-summed
// per-day scalars are kept only when they agree); at creative level one per creative (campaign_tag)
// and day, languages merged the same way. A day without a single stored row has no report row: it
// is skipped, never filled with zeros. Rows of different row sets are never combined: two sources
// are two series in one table.

/** What one cell holds: the date and the names, a fixed text, or a formula's number (null = none). */
export type CellValue = string | number | null

/** The cells of one row, in the order of CompiledFields.names. */
export type ReportRow = readonly CellValue[]

/** One analytics.advanced_analytics row of a source, for one language and creative. */
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

/** Non-internal CTA clicks of one creative of a campaign on one day, all languages together. */
export interface ClicksRecord {
  campaignId: string
  campaign: string
  price: string | null
  date: IsoDate
  campaignTag: string
  /** Exact integer text. */
  clicks: string
}

/** Everything one source contributes to a report. */
export interface SourceData {
  source: string
  metrics: readonly MetricsRecord[]
  clicks: readonly ClicksRecord[]
  /** The label of each creative, by labelKey; a tag without one prints the tag itself. */
  labels: ReadonlyMap<string, string>
}

export const labelKey = (campaignId: string, campaignTag: string): string =>
  `${campaignId}\u0000${campaignTag}`

interface Group {
  campaignId: string
  campaign: string
  price: string | null
  date: IsoDate
  /** The creative's tag at creative level; '' at campaign level. */
  campaignTag: string
  rows: CanonicalDailyRow[]
  clicks: bigint | null
}

interface Built {
  date: IsoDate
  campaign: string
  campaignId: string
  setIndex: number
  creative: string
  campaignTag: string
  row: ReportRow
}

const NO_DATA: Omit<SourceData, 'source'> = { metrics: [], clicks: [], labels: new Map() }

export function assembleRows(
  fields: CompiledFields,
  data: readonly SourceData[],
  warn: MergeWarning = () => undefined,
): ReportRow[] {
  const built = fields.rowSets.flatMap((set, setIndex) => {
    const source = data.find((entry) => entry.source === set.source) ?? NO_DATA
    return buildRowSet(fields, set, setIndex, source, warn)
  })
  return built.sort(byDateCampaignSetCreative).map((entry) => entry.row)
}

function buildRowSet(
  fields: CompiledFields,
  set: CompiledRowSet,
  setIndex: number,
  source: Omit<SourceData, 'source'>,
  warn: MergeWarning,
): Built[] {
  const perCreative = set.level === 'creative'
  const groups = new Map<string, Group>()
  const groupOf = (record: {
    campaignId: string
    campaign: string
    price: string | null
    date: IsoDate
    campaignTag: string
  }) => {
    const campaignTag = perCreative ? record.campaignTag : ''
    const key = JSON.stringify([record.campaignId, record.date, campaignTag])
    let group = groups.get(key)
    if (!group) {
      group = {
        campaignId: record.campaignId,
        campaign: record.campaign,
        price: record.price,
        date: record.date,
        campaignTag,
        rows: [],
        clicks: null,
      }
      groups.set(key, group)
    }
    return group
  }

  for (const record of source.metrics) {
    // One key per group for every language (and, at campaign level, every creative), so mergeRows
    // folds them into one row.
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
  if (set.usesClicks) {
    // Clicks are a sum: adding a campaign's creatives together is the catalog's rule for them.
    for (const record of source.clicks) {
      const group = groupOf(record)
      group.clicks = (group.clicks ?? 0n) + BigInt(record.clicks)
    }
  }

  return [...groups.values()].map((group): Built => {
    const merged =
      mergeRows(group.rows, (message) => {
        warn(`${group.campaign}: ${message}`)
      })[0]?.metrics ?? {}
    const price = group.price === null ? null : parseDecimal(group.price)
    const clicks = group.clicks === null ? null : parseDecimal(group.clicks.toString())

    const lookup = (name: string): Fraction | null => {
      if (name === PRICE_VARIABLE) return price
      if (name === CLICKS_VARIABLE) return clicks
      const value = Object.hasOwn(merged, name) ? merged[name as MetricId] : undefined
      return typeof value === 'number' ? fromNumber(value) : null
    }

    // A creative is named by its entity's label, or by its tag when nobody labelled it.
    const creative = perCreative
      ? (source.labels.get(labelKey(group.campaignId, group.campaignTag)) ?? group.campaignTag)
      : ''
    const cells = set.cells.map((cell): CellValue => {
      switch (cell.kind) {
        case 'formula': {
          const value = evaluate(cell.expr, lookup)
          return value === null ? null : toRoundedNumber(value, cell.decimals)
        }
        case 'text':
          return cell.value
        case 'variable':
          return cell.variable === 'source' ? set.source : set.level
        case 'empty':
          return null
      }
    })

    return {
      date: group.date,
      campaign: group.campaign,
      campaignId: group.campaignId,
      setIndex,
      creative,
      campaignTag: group.campaignTag,
      row: [
        group.date,
        // A creative-level row named after its creative; the campaign when it has no name at all.
        set.name === 'creative' && creative !== '' ? creative : group.campaign,
        ...(fields.creativeColumn
          ? [set.name === 'campaign' && perCreative ? creative : null]
          : []),
        ...cells,
      ],
    }
  })
}

/**
 * Day by day; within a day by campaign name, then id so two campaigns of one name stay apart; then
 * the row sets in the order the admin listed them (the campaign row before its creatives); then
 * the creatives by name.
 */
function byDateCampaignSetCreative(a: Built, b: Built): number {
  return (
    compare(a.date, b.date) ||
    compare(a.campaign, b.campaign) ||
    compare(a.campaignId, b.campaignId) ||
    a.setIndex - b.setIndex ||
    compare(a.creative, b.creative) ||
    compare(a.campaignTag, b.campaignTag)
  )
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
