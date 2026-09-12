import type { CanonicalDailyRow, MetricId } from './types.ts'

// Several entities (NEXD live_ids, Zeus creatives + pixels) can feed the same (date, language,
// campaign_tag) row. Sums are per key; dwell_avg_ms is averaged weighted by game_started
// (RFC-004 §5.1). Absent metrics stay absent.

interface DwellAccumulator {
  weightedSum: number
  weight: number
  plainSum: number
  count: number
}

export function mergeRows(rows: readonly CanonicalDailyRow[]): CanonicalDailyRow[] {
  const merged = new Map<string, CanonicalDailyRow>()
  const dwell = new Map<string, DwellAccumulator>()

  for (const row of rows) {
    const key = `${row.date}|${row.language}|${row.campaignTag}`
    let target = merged.get(key)
    if (!target) {
      target = {
        date: row.date,
        language: row.language,
        campaignTag: row.campaignTag,
        metrics: {},
        pageViews: [],
        ctaClicks: [],
        unmapped: {},
      }
      merged.set(key, target)
    }

    for (const [id, value] of Object.entries(row.metrics) as [MetricId, number][]) {
      if (id === 'dwell_avg_ms') continue
      target.metrics[id] = (target.metrics[id] ?? 0) + value
    }
    if (row.metrics.dwell_avg_ms !== undefined) {
      const acc = dwell.get(key) ?? { weightedSum: 0, weight: 0, plainSum: 0, count: 0 }
      const weight = row.metrics.game_started ?? 0
      acc.weightedSum += row.metrics.dwell_avg_ms * weight
      acc.weight += weight
      acc.plainSum += row.metrics.dwell_avg_ms
      acc.count += 1
      dwell.set(key, acc)
      // Without any game_started weight there is nothing to weight by: plain mean.
      target.metrics.dwell_avg_ms =
        acc.weight > 0 ? acc.weightedSum / acc.weight : acc.plainSum / acc.count
    }
    mergeCounts(target.pageViews, row.pageViews, 'pageId')
    mergeCounts(target.ctaClicks, row.ctaClicks, 'ctaId')
    mergeUnmapped(target.unmapped, row.unmapped)
  }

  return [...merged.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.language.localeCompare(b.language) ||
      a.campaignTag.localeCompare(b.campaignTag),
  )
}

function mergeCounts<K extends 'pageId' | 'ctaId'>(
  target: (Record<K, string> & { count: number })[],
  source: readonly (Record<K, string> & { count: number })[],
  key: K,
): void {
  for (const item of source) {
    const existing = target.find((t) => t[key] === item[key])
    if (existing) existing.count += item.count
    else target.push({ ...item })
  }
}

function mergeUnmapped(target: Record<string, number>, source: Record<string, number>): void {
  for (const [name, count] of Object.entries(source)) target[name] = (target[name] ?? 0) + count
}

export function groupByDate(rows: readonly CanonicalDailyRow[]): Map<string, CanonicalDailyRow[]> {
  const byDate = new Map<string, CanonicalDailyRow[]>()
  for (const row of rows) {
    const list = byDate.get(row.date) ?? []
    list.push(row)
    byDate.set(row.date, list)
  }
  return new Map([...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)))
}
