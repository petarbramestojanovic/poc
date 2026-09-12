import type { Queryable, Tx } from '../db.ts'
import type { IsoDate } from '../dates.ts'
import { sqlFile } from '../sql-file.ts'
import { METRIC_IDS, type CanonicalDailyRow, type MetricId } from './types.ts'

// The day-replace write (RFC-003 §4): under the link's transaction-scoped advisory lock,
// delete the (campaign, source, language, day) slice from all three rollup tables, then
// insert the fresh rows stamped data_source = 'sync'. An upsert would be wrong: it cannot
// remove a key that disappeared from the source.

const sql = (name: string) => sqlFile(import.meta.url, name)

export interface DaySlice {
  linkId: string
  campaignId: string
  source: string
  language: string
  date: IsoDate
  syncRunId: string
  /** Already merged: at most one row per campaign_tag. */
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
  const [deleted] = await tx.query<DeletedRow>(sql('delete_day'), key)
  const insertKey = [slice.campaignId, slice.source, slice.language, slice.date, slice.syncRunId]

  const advanced = slice.rows.filter((row) => Object.keys(row.metrics).length > 0)
  if (advanced.length > 0) {
    const column = (id: MetricId) => advanced.map((row) => row.metrics[id] ?? null)
    await tx.query(sql('insert_advanced'), [
      ...insertKey,
      advanced.map((row) => row.campaignTag),
      ...METRIC_IDS.map(column),
    ])
  }

  const pageViews = slice.rows.flatMap((row) =>
    row.pageViews.map((p) => ({ tag: row.campaignTag, ...p })),
  )
  if (pageViews.length > 0) {
    await tx.query(sql('insert_page_views'), [
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
    await tx.query(sql('insert_cta_clicks'), [
      ...insertKey,
      ctaClicks.map((c) => c.tag),
      ctaClicks.map((c) => c.ctaId),
      ctaClicks.map((c) => c.count),
    ])
  }

  const unmapped = new Map<string, number>()
  for (const row of slice.rows) {
    for (const [name, count] of Object.entries(row.unmapped))
      unmapped.set(name, (unmapped.get(name) ?? 0) + count)
  }
  if (unmapped.size > 0) {
    await tx.query(sql('upsert_unmapped'), [
      slice.linkId,
      slice.date,
      [...unmapped.keys()],
      [...unmapped.values()],
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

export interface DayDiff {
  date: IsoDate
  rows: { before: number; after: number }
  metrics: Partial<Record<MetricId, { before: number | null; after: number | null }>>
  pageViews: { before: number; after: number }
  ctaClicks: { before: number; after: number }
}

/** What a real run would change for one day, computed without writing (dry run). */
export async function diffDay(db: Queryable, slice: Omit<DaySlice, 'syncRunId'>): Promise<DayDiff> {
  const key = [slice.campaignId, slice.source, slice.language, slice.date]
  const [existing, pages, ctas] = await Promise.all([
    db.query<Record<string, string | number | null>>(sql('select_day_advanced'), key),
    db.query<{ count: string }>(sql('select_day_page_views'), key),
    db.query<{ count: string }>(sql('select_day_cta_clicks'), key),
  ])

  const metrics: DayDiff['metrics'] = {}
  for (const id of METRIC_IDS) {
    const before = sumOrNull(existing.map((row) => row[id]))
    const after = sumOrNull(slice.rows.map((row) => row.metrics[id]))
    if (before !== null || after !== null) metrics[id] = { before, after }
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
    pageViews: { before: total(pages), after: total(slice.rows.flatMap((r) => r.pageViews)) },
    ctaClicks: { before: total(ctas), after: total(slice.rows.flatMap((r) => r.ctaClicks)) },
  }
}

function sumOrNull(values: (string | number | null | undefined)[]): number | null {
  const present = values.filter((v): v is string | number => v !== null && v !== undefined)
  if (present.length === 0) return null
  return present.reduce<number>((acc, v) => acc + Number(v), 0)
}
