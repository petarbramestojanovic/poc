import { describe, expect, it } from 'vitest'
import { groupByDate, mergeRows } from '../../src/sync/merge.ts'
import type { CanonicalDailyRow } from '../../src/sync/types.ts'

const row = (over: Partial<CanonicalDailyRow>): CanonicalDailyRow => ({
  date: '2026-09-01',
  language: 'de',
  campaignTag: 'a',
  metrics: {},
  pageViews: [],
  ctaClicks: [],
  unmapped: {},
  ...over,
})

describe('mergeRows', () => {
  it('sums metrics, pages, CTAs and unmapped for the same (date, language, tag)', () => {
    const merged = mergeRows([
      row({
        metrics: { impressions: 10, in_view: 5 },
        pageViews: [{ pageId: 'main', count: 3 }],
        ctaClicks: [{ ctaId: 'x', count: 1 }],
        unmapped: { e: 1 },
      }),
      row({
        metrics: { impressions: 20, game_started: 4 },
        pageViews: [
          { pageId: 'main', count: 2 },
          { pageId: 'r', count: 1 },
        ],
        ctaClicks: [{ ctaId: 'x', count: 2 }],
        unmapped: { e: 2, f: 1 },
      }),
    ])
    expect(merged).toEqual([
      row({
        metrics: { impressions: 30, in_view: 5, game_started: 4 },
        pageViews: [
          { pageId: 'main', count: 5 },
          { pageId: 'r', count: 1 },
        ],
        ctaClicks: [{ ctaId: 'x', count: 3 }],
        unmapped: { e: 3, f: 1 },
      }),
    ])
  })

  it('returns a single row unchanged', () => {
    const only = row({
      metrics: { impressions: 1, dwell_avg_ms: 5 },
      pageViews: [{ pageId: 'p', count: 1 }],
    })
    expect(mergeRows([only])).toEqual([only])
  })

  it('weights dwell_avg_ms by game_started', () => {
    const [merged] = mergeRows([
      row({ metrics: { game_started: 100, dwell_avg_ms: 20_000 } }),
      row({ metrics: { game_started: 300, dwell_avg_ms: 40_000 } }),
    ])
    expect(merged?.metrics).toEqual({ game_started: 400, dwell_avg_ms: 35_000 })
  })

  it('falls back to a plain mean when no game_started weight exists', () => {
    const [merged] = mergeRows([
      row({ metrics: { dwell_avg_ms: 10 } }),
      row({ metrics: { dwell_avg_ms: 30 } }),
    ])
    expect(merged?.metrics.dwell_avg_ms).toBe(20)
  })

  it('keeps different tags, languages and dates apart and sorts the result', () => {
    const merged = mergeRows([
      row({ date: '2026-09-02', campaignTag: 'b' }),
      row({ campaignTag: 'b' }),
      row({ language: '' }),
      row({ campaignTag: 'a' }),
    ])
    expect(merged.map((r) => `${r.date}|${r.language}|${r.campaignTag}`)).toEqual([
      '2026-09-01||a',
      '2026-09-01|de|a',
      '2026-09-01|de|b',
      '2026-09-02|de|b',
    ])
  })

  it('does not mutate its input', () => {
    const input = [row({ metrics: { impressions: 1 } }), row({ metrics: { impressions: 1 } })]
    mergeRows(input)
    expect(input[0]?.metrics.impressions).toBe(1)
  })

  it('groups rows by date in order', () => {
    const grouped = groupByDate([
      row({ date: '2026-09-03' }),
      row({ date: '2026-09-01' }),
      row({ date: '2026-09-03', campaignTag: 'b' }),
    ])
    expect([...grouped.keys()]).toEqual(['2026-09-01', '2026-09-03'])
    expect(grouped.get('2026-09-03')).toHaveLength(2)
  })
})
