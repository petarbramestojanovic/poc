import { assertIsoDate, todayIn, type IsoDate } from '../../../dates.ts'
import type { CanonicalDailyRow, EventMapEntry, MetricId } from '../../types.ts'
import { NexdContractError } from './errors.ts'
import type { NexdEventItem, NexdPerformanceItem } from './schema.ts'

// Pure: one NEXD day (performance row + that day's events) → one CanonicalDailyRow.
// Metrics NEXD does not measure (game_finished, the *_time counters) are simply absent.

export interface NexdDay {
  date: IsoDate
  performance: NexdPerformanceItem
  events: NexdEventItem[]
}

export interface NexdMapperInput {
  language: string
  campaignTag: string
  eventMap: EventMapEntry[]
  days: NexdDay[]
}

/** Plan §NEXD: these two events map to metrics regardless of the link's event_map. */
const BUILT_IN_EVENT_MAP: EventMapEntry[] = [
  { eventName: 'Unique [Touch]', targetKind: 'metric', targetId: 'interactions' },
  { eventName: 'Unique [Hover]', targetKind: 'metric', targetId: 'hovered' },
]

/**
 * The calendar day of a performance item. `date` (undocumented, returned today) is taken as
 * written; the documented `dt` timestamp is converted in the source's day zone.
 */
export function performanceDate(item: NexdPerformanceItem, timeZone = 'UTC'): IsoDate {
  try {
    if (item.date !== undefined) return assertIsoDate(item.date.slice(0, 10))
    if (typeof item.dt === 'number') return todayIn(timeZone, new Date(item.dt * 1000))
    if (typeof item.dt === 'string') return todayIn(timeZone, new Date(item.dt))
  } catch (cause) {
    throw new NexdContractError(`NEXD performance item has an invalid date`, { cause })
  }
  throw new NexdContractError('NEXD performance item has neither `date` nor `dt`')
}

export function mapNexdRows(input: NexdMapperInput): CanonicalDailyRow[] {
  const eventMap = new Map<string, EventMapEntry>()
  for (const entry of [...BUILT_IN_EVENT_MAP, ...input.eventMap]) {
    eventMap.set(entry.eventName, entry)
  }

  return input.days.map(({ date, performance, events }) => {
    const row: CanonicalDailyRow = {
      date,
      language: input.language,
      campaignTag: input.campaignTag,
      metrics: {
        impressions: performance.impressions,
        in_view: performance.viewable.value,
        game_started: performance.engagement.value,
        dwell_avg_ms: performance.dwell,
      },
      pageViews: [],
      ctaClicks: [],
      unmapped: new Map(),
    }

    for (const event of events) {
      const name = event.action.original
      const target = eventMap.get(name)
      if (!target) {
        row.unmapped.set(name, (row.unmapped.get(name) ?? 0) + event.count)
        continue
      }
      switch (target.targetKind) {
        case 'metric': {
          const id = target.targetId as MetricId
          row.metrics[id] = (row.metrics[id] ?? 0) + event.count
          break
        }
        case 'page_view':
          addCount(row.pageViews, 'pageId', target.targetId ?? '', event.count)
          break
        case 'cta_click':
          addCount(row.ctaClicks, 'ctaId', target.targetId ?? '', event.count)
          break
        case 'ignore':
          break
      }
    }
    return row
  })
}

type Counted<K extends string> = Record<K, string> & { count: number }

function addCount<K extends string>(list: Counted<K>[], key: K, id: string, count: number): void {
  const existing = list.find((item) => item[key] === id)
  if (existing) existing.count += count
  else list.push({ [key]: id, count } as Counted<K>)
}
