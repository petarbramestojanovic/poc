import type { Queryable, Tx } from '../../core/db.ts'
import type { IsoDate } from '../../core/dates.ts'
import { loadSql } from '../../core/sql-file.ts'
import {
  METRIC_AGGREGATION,
  METRIC_IDS,
  METRIC_WEIGHT,
  type CanonicalDailyRow,
  type MetricId,
} from './types.ts'

// The day-replace write (RFC-003 §4): under the link's transaction-scoped advisory lock,
// delete the (campaign, source, language, day) slice from all three rollup tables, then
// insert the fresh rows stamped data_source = 'sync'. An upsert would be wrong: it cannot
// remove a key that disappeared from the source. An EMPTY slice is a valid write: it clears
// a day the source no longer reports.

const sql = loadSql(import.meta.url, [
  'delete_day',
  'insert_advanced',
  'insert_page_views',
  'insert_cta_clicks',
  'select_day_advanced',
  'select_day_page_views',
  'select_day_cta_clicks',
] as const)

export interface DaySlice {
  linkId: string
  campaignId: string
  source: string
  language: string
  date: IsoDate
  syncRunId: string
  /** Already merged: at most one row per campaign_tag. May be empty. */
  rows: CanonicalDailyRow[]
}

export interface DayWriteCounts {
  deleted: { advanced: number; pageViews: number; ctaClicks: number }
  inserted: { advanced: number; pageViews: number; ctaClicks: number }
}

interface DeletedRow {
  advanced: number
  page_views: number
  cta_clicks: number
}

export async function writeDay(tx: Tx, slice: DaySlice): Promise<DayWriteCounts> {
  await tx.xactLock(slice.linkId)

  const key = [slice.campaignId, slice.source, slice.language, slice.date]
  const [deleted] = await tx.query<DeletedRow>(sql.delete_day, key)
  const insertKey = [slice.campaignId, slice.source, slice.language, slice.date, slice.syncRunId]

  const advanced = slice.rows.filter((row) => Object.keys(row.metrics).length > 0)
  if (advanced.length > 0) {
    // Positional: METRIC_IDS order must equal the unnest column order in insert_advanced.sql.
    const column = (id: MetricId) => advanced.map((row) => row.metrics[id] ?? null)
    await tx.query(sql.insert_advanced, [
      ...insertKey,
      advanced.map((row) => row.campaignTag),
      ...METRIC_IDS.map(column),
    ])
  }

  const pageViews = slice.rows.flatMap((row) =>
    row.pageViews.map((p) => ({ tag: row.campaignTag, ...p })),
  )
  if (pageViews.length > 0) {
    await tx.query(sql.insert_page_views, [
      ...insertKey,
      pageViews.map((p) => p.tag),
      pageViews.map((p) => p.pageId),
      pageViews.map((p) => p.count),
    ])
  }

  const ctaClicks = slice.rows.flatMap((row) =>
    row.ctaClicks.map((c) => ({ tag: row.campaignTag, ...c })),
  )
  if (ctaClicks.length > 0) {
    await tx.query(sql.insert_cta_clicks, [
      ...insertKey,
      ctaClicks.map((c) => c.tag),
      ctaClicks.map((c) => c.ctaId),
      ctaClicks.map((c) => c.count),
    ])
  }

  return {
    deleted: {
      advanced: deleted?.advanced ?? 0,
      pageViews: deleted?.page_views ?? 0,
      ctaClicks: deleted?.cta_clicks ?? 0,
    },
    inserted: {
      advanced: advanced.length,
      pageViews: pageViews.length,
      ctaClicks: ctaClicks.length,
    },
  }
}

export interface MetricDiff {
  before: number | null
  after: number | null
}

export interface TagScalarDiff extends MetricDiff {
  campaignTag: string
}

export interface DayDiff {
  date: IsoDate
  rows: { before: number; after: number }
  /** Day totals for `sum` metrics, weighted day averages for `weighted_avg` metrics. */
  metrics: Partial<Record<MetricId, MetricDiff>>
  /** `none` metrics cannot be totalled across tags: listed per tag, only where the value changes. */
  perTag: Partial<Record<MetricId, TagScalarDiff[]>>
  pageViews: { before: number; after: number }
  ctaClicks: { before: number; after: number }
}

type StoredRow = Record<string, string | number | null>

/** What a real run would change for one day, computed without writing (dry run). */
export async function diffDay(db: Queryable, slice: Omit<DaySlice, 'syncRunId'>): Promise<DayDiff> {
  const key = [slice.campaignId, slice.source, slice.language, slice.date]
  const existing = await db.query<StoredRow>(sql.select_day_advanced, key)
  const pages = await db.query<{ count: string }>(sql.select_day_page_views, key)
  const ctas = await db.query<{ count: string }>(sql.select_day_cta_clicks, key)

  const stored = (row: StoredRow, id: MetricId) => toNumber(row[id])
  const metrics: DayDiff['metrics'] = {}
  const perTag: DayDiff['perTag'] = {}

  for (const id of METRIC_IDS) {
    switch (METRIC_AGGREGATION[id]) {
      case 'sum': {
        const before = sumOrNull(existing.map((row) => stored(row, id)))
        const after = sumOrNull(slice.rows.map((row) => row.metrics[id] ?? null))
        if (before !== null || after !== null) metrics[id] = { before, after }
        break
      }
      case 'weighted_avg': {
        const weightId = METRIC_WEIGHT[id]
        const before = weightedAverage(
          existing.map((row) => ({
            value: stored(row, id),
            weight: weightId ? stored(row, weightId) : null,
          })),
        )
        const after = weightedAverage(
          slice.rows.map((row) => ({
            value: row.metrics[id] ?? null,
            weight: weightId ? (row.metrics[weightId] ?? null) : null,
          })),
        )
        if (before !== null || after !== null) metrics[id] = { before, after }
        break
      }
      case 'none': {
        const beforeByTag = new Map(
          existing.map((row) => [String(row.campaign_tag), stored(row, id)]),
        )
        const afterByTag = new Map(
          slice.rows.map((row) => [row.campaignTag, row.metrics[id] ?? null]),
        )
        const changes: TagScalarDiff[] = []
        for (const tag of new Set([...beforeByTag.keys(), ...afterByTag.keys()])) {
          const before = beforeByTag.get(tag) ?? null
          const after = afterByTag.get(tag) ?? null
          if (before !== after) changes.push({ campaignTag: tag, before, after })
        }
        if (changes.length > 0) perTag[id] = changes
        break
      }
    }
  }

  const total = (list: { count: number | string }[]) =>
    list.reduce((acc, item) => acc + Number(item.count), 0)

  return {
    date: slice.date,
    rows: {
      before: existing.length,
      after: slice.rows.filter((r) => Object.keys(r.metrics).length > 0).length,
    },
    metrics,
    perTag,
    pageViews: { before: total(pages), after: total(slice.rows.flatMap((r) => r.pageViews)) },
    ctaClicks: { before: total(ctas), after: total(slice.rows.flatMap((r) => r.ctaClicks)) },
  }
}

function toNumber(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null)
  if (present.length === 0) return null
  return present.reduce((acc, v) => acc + v, 0)
}

function weightedAverage(pairs: { value: number | null; weight: number | null }[]): number | null {
  const present = pairs.filter(
    (p): p is { value: number; weight: number | null } => p.value !== null,
  )
  if (present.length === 0) return null
  const totalWeight = present.reduce((acc, p) => acc + (p.weight ?? 0), 0)
  if (totalWeight > 0) {
    return present.reduce((acc, p) => acc + p.value * (p.weight ?? 0), 0) / totalWeight
  }
  return present.reduce((acc, p) => acc + p.value, 0) / present.length
}
