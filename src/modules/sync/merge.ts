import {
  METRIC_AGGREGATION,
  METRIC_WEIGHT,
  type CanonicalDailyRow,
  type MetricId,
} from './types.ts'

// Several entities (NEXD live_ids, Zeus creatives + pixels) can feed the same (date, language,
// campaign_tag) row. Each metric merges by its declared aggregation (RFC-004 §5.1):
//   sum          → added
//   weighted_avg → averaged, weighted by its weight metric (plain mean without any weight)
//   none         → a per-day scalar that can never be added (the same person may be in both
//                  entities): kept when exactly one value exists or all agree, dropped otherwise
// Absent metrics stay absent.

interface AverageAccumulator {
  weightedSum: number
  weight: number
  plainSum: number
  count: number
}

export type MergeWarning = (message: string) => void

export function mergeRows(
  rows: readonly CanonicalDailyRow[],
  warn: MergeWarning = () => undefined,
): CanonicalDailyRow[] {
  const merged = new Map<string, CanonicalDailyRow>()
  const averages = new Map<string, AverageAccumulator>()
  const scalars = new Map<string, number | null>() // null = entities disagreed

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
        unmapped: new Map(),
      }
      merged.set(key, target)
    }

    for (const [id, value] of Object.entries(row.metrics) as [MetricId, number][]) {
      const metricKey = `${key}|${id}`
      switch (METRIC_AGGREGATION[id]) {
        case 'sum':
          target.metrics[id] = (target.metrics[id] ?? 0) + value
          break
        case 'weighted_avg': {
          const weightId = METRIC_WEIGHT[id]
          const weight = weightId === undefined ? 0 : (row.metrics[weightId] ?? 0)
          const acc = averages.get(metricKey) ?? {
            weightedSum: 0,
            weight: 0,
            plainSum: 0,
            count: 0,
          }
          acc.weightedSum += value * weight
          acc.weight += weight
          acc.plainSum += value
          acc.count += 1
          averages.set(metricKey, acc)
          target.metrics[id] =
            acc.weight > 0 ? acc.weightedSum / acc.weight : acc.plainSum / acc.count
          break
        }
        case 'none': {
          if (!scalars.has(metricKey)) {
            scalars.set(metricKey, value)
            target.metrics[id] = value
          } else if (scalars.get(metricKey) !== value && scalars.get(metricKey) !== null) {
            scalars.set(metricKey, null)
            target.metrics = Object.fromEntries(
              Object.entries(target.metrics).filter(([metric]) => metric !== id),
            )
            warn(
              `${id} dropped for ${row.date} tag '${row.campaignTag}': several entities report different per-day values, which cannot be added`,
            )
          }
          break
        }
      }
    }
    mergeCounts(target.pageViews, row.pageViews, 'pageId')
    mergeCounts(target.ctaClicks, row.ctaClicks, 'ctaId')
    for (const [name, count] of row.unmapped) {
      target.unmapped.set(name, (target.unmapped.get(name) ?? 0) + count)
    }
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

export function groupByDate(rows: readonly CanonicalDailyRow[]): Map<string, CanonicalDailyRow[]> {
  const byDate = new Map<string, CanonicalDailyRow[]>()
  for (const row of rows) {
    const list = byDate.get(row.date) ?? []
    list.push(row)
    byDate.set(row.date, list)
  }
  return new Map([...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)))
}
