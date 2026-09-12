import { describe, expect, it } from 'vitest'
import {
  mapNexdRows,
  performanceDate,
  type NexdDay,
} from '../../../src/sync/connectors/nexd/mapper.ts'
import { nexdResponse } from '../../../src/sync/connectors/nexd/schema.ts'
import type { CanonicalDailyRow } from '../../../src/sync/types.ts'
import { EVENT_MAP, KNOWN_TOTALS, loadFixture } from './helpers.ts'

function fixtureDays(): NexdDay[] {
  const { analytics } = nexdResponse.parse(loadFixture()).result
  return analytics.performance.map((performance) => {
    const date = performanceDate(performance)
    return { date, performance, events: analytics.eventsList?.[date] ?? [] }
  })
}

const sum = (rows: CanonicalDailyRow[], pick: (r: CanonicalDailyRow) => number | undefined) =>
  rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0)

describe('NEXD mapper', () => {
  const rows = mapNexdRows({
    language: 'de',
    campaignTag: 'nx_1',
    eventMap: EVENT_MAP,
    days: fixtureDays(),
  })

  it('reproduces the known sample totals', () => {
    expect(rows).toHaveLength(7)
    expect(sum(rows, (r) => r.metrics.impressions)).toBe(KNOWN_TOTALS.impressions)
    expect(sum(rows, (r) => r.metrics.in_view)).toBe(KNOWN_TOTALS.in_view)
    expect(sum(rows, (r) => r.metrics.game_started)).toBe(KNOWN_TOTALS.game_started)
    expect(sum(rows, (r) => r.metrics.interactions)).toBe(KNOWN_TOTALS.interactions)
    expect(sum(rows, (r) => r.metrics.hovered)).toBe(KNOWN_TOTALS.hovered)
  })

  it('stamps language, campaign tag and date, and keeps dwell as a per-day average', () => {
    expect(rows[0]).toMatchObject({ date: '2026-08-31', language: 'de', campaignTag: 'nx_1' })
    expect(rows[0]?.metrics.dwell_avg_ms).toBe(21_000)
    expect(rows.map((r) => r.date)).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ])
  })

  it('omits metrics NEXD does not measure instead of writing zero', () => {
    for (const row of rows) {
      expect(row.metrics).not.toHaveProperty('game_finished')
      expect(row.metrics).not.toHaveProperty('unique_impressions_reported')
      expect(row.metrics).not.toHaveProperty('dwell_time')
    }
  })

  it('routes events through the event map into pages, CTAs and unmapped', () => {
    expect(sum(rows, (r) => r.pageViews.find((p) => p.pageId === 'main')?.count)).toBe(
      KNOWN_TOTALS.game_started,
    )
    expect(sum(rows, (r) => r.pageViews.find((p) => p.pageId === 'result')?.count)).toBe(2_140)
    expect(sum(rows, (r) => r.ctaClicks.find((c) => c.ctaId === 'clickthrough')?.count)).toBe(860)
    expect(sum(rows, (r) => r.unmapped['Sound on'])).toBe(350)
    expect(Object.keys(rows[0]?.unmapped ?? {})).toEqual(['Sound on'])
  })

  it("lets the link's event map override built-ins and honours ignore", () => {
    const custom = mapNexdRows({
      language: '',
      campaignTag: '',
      eventMap: [
        { eventName: 'Unique [Hover]', targetKind: 'ignore', targetId: null },
        { eventName: 'Sound on', targetKind: 'metric', targetId: 'game_finished' },
      ],
      days: fixtureDays().slice(0, 1),
    })
    expect(custom[0]?.metrics.hovered).toBeUndefined()
    expect(custom[0]?.metrics.game_finished).toBe(50)
    expect(custom[0]?.unmapped).toEqual({
      'Page seen [Main]': 700,
      'Page seen [Result]': 300,
      'CTR [global]': 120,
    })
  })

  it('accepts the documented `dt` timestamp as well as `date`', () => {
    const base = { impressions: 1, viewable: { value: 1 }, engagement: { value: 1 }, dwell: 1 }
    expect(performanceDate({ ...base, date: '2026-09-01' })).toBe('2026-09-01')
    expect(performanceDate({ ...base, dt: Date.UTC(2026, 8, 1, 12) / 1000 })).toBe('2026-09-01')
    expect(performanceDate({ ...base, dt: '2026-09-01T00:00:00Z' })).toBe('2026-09-01')
    expect(() => performanceDate(base)).toThrow('neither')
  })
})
