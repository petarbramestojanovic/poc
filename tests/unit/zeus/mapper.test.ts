import { describe, expect, it } from 'vitest'
import {
  checkZeusInvariants,
  mapZeusRows,
  ZeusInvariantError,
  type Matched,
} from '../../../src/sync/connectors/zeus/mapper.ts'
import {
  zeusCampaignsRow,
  zeusCreativesRow,
  zeusTrackerRow,
  type ZeusCreativesRow,
  type ZeusTrackerRow,
} from '../../../src/sync/connectors/zeus/schema.ts'
import { ENTITIES, loadFixture } from './helpers.ts'

const creatives = (): Matched<ZeusCreativesRow>[] =>
  loadFixture('creatives').rows.map((raw) => {
    const row = zeusCreativesRow.parse(raw)
    return { entity: row.creative_id === '12345' ? ENTITIES.mpuV1 : ENTITIES.mpuV2, row }
  })

const tracker = (): Matched<ZeusTrackerRow>[] =>
  loadFixture('tracker')
    .rows.map((raw) => zeusTrackerRow.parse(raw))
    .filter((row) => row.code !== 'otherpx')
    .map((row) => ({ entity: row.code === 'dev1eng' ? ENTITIES.engagement : ENTITIES.finish, row }))

const campaignRow = zeusCampaignsRow.parse({
  date: '2026-09-01',
  campaign_id: '501',
  impressions: 30_000,
  clicks: 210,
  visible_impressions: 23_500,
})

describe('Zeus mapper', () => {
  const rows = mapZeusRows({
    language: 'de',
    clickthroughCtaId: 'clickthrough',
    creatives: creatives(),
    campaigns: [],
    tracker: tracker(),
    unmatchedPixels: [
      { label: 'pixel 9999 "Other campaign pixel"', date: '2026-09-01', fires: 40 },
    ],
  })

  it('produces one row per (date, campaign_tag) from the creatives report', () => {
    expect(rows.map((r) => `${r.date}|${r.campaignTag}`)).toEqual([
      '2026-09-01|',
      '2026-09-01|mpu_v1',
      '2026-09-01|mpu_v2',
      '2026-09-02|mpu_v1',
      '2026-09-02|mpu_v2',
      '2026-09-03|mpu_v1',
      '2026-09-03|mpu_v2',
    ])
    expect(rows[1]).toMatchObject({
      language: 'de',
      metrics: {
        impressions: 20_000,
        in_view: 16_000,
        unique_impressions_reported: 17_000,
        unique_clicks_reported: 140,
      },
      ctaClicks: [{ ctaId: 'clickthrough', count: 150 }],
      pageViews: [],
    })
  })

  it('attributes engagement and finish pixel fires to the pixel entity’s campaign_tag only', () => {
    const v1 = rows.filter((r) => r.campaignTag === 'mpu_v1')
    const v2 = rows.filter((r) => r.campaignTag === 'mpu_v2')
    expect(v1.map((r) => r.metrics.game_started)).toEqual([600, 620, 640])
    expect(v1.map((r) => r.metrics.game_finished)).toEqual([290, 300, 310])
    for (const row of v2) {
      expect(row.metrics).not.toHaveProperty('game_started')
      expect(row.metrics).not.toHaveProperty('game_finished')
    }
  })

  it('never stores ratios or metrics Zeus does not measure', () => {
    for (const row of rows) {
      expect(Object.keys(row.metrics)).not.toContain('ctr')
      expect(Object.keys(row.metrics)).not.toContain('visibility')
      expect(row.metrics).not.toHaveProperty('dwell_avg_ms')
      expect(row.metrics).not.toHaveProperty('interactions')
    }
  })

  it('puts unmatched pixels into unmapped on an untagged row', () => {
    expect(rows[0]?.campaignTag).toBe('')
    expect(rows[0]?.metrics).toEqual({})
    expect(rows[0]?.unmapped).toEqual(new Map([['pixel 9999 "Other campaign pixel"', 40]]))
  })

  it('adds counts across creatives sharing a tag but never adds their per-day unique scalars', () => {
    const [first, second] = creatives().filter((c) => c.row.date === '2026-09-01')
    if (!first || !second) throw new Error('fixture needs two creatives on 2026-09-01')
    const sameTag = { ...ENTITIES.mpuV1, campaignTag: 'shared' }
    const warnings: string[] = []
    const merged = mapZeusRows(
      {
        language: 'de',
        clickthroughCtaId: 'clickthrough',
        creatives: [
          { entity: sameTag, row: first.row },
          { entity: sameTag, row: second.row },
        ],
        campaigns: [],
        tracker: [],
        unmatchedPixels: [],
      },
      (w) => warnings.push(w),
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.metrics.impressions).toBe(first.row.impressions + second.row.impressions)
    expect(merged[0]?.ctaClicks).toEqual([
      { ctaId: 'clickthrough', count: first.row.clicks + second.row.clicks },
    ])
    expect(merged[0]?.metrics).not.toHaveProperty('unique_impressions_reported')
    expect(merged[0]?.metrics).not.toHaveProperty('unique_clicks_reported')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('uses the campaigns report the same way when a link has no creatives', () => {
    const campaignRows = mapZeusRows({
      language: '',
      clickthroughCtaId: 'clickthrough',
      creatives: [],
      campaigns: [{ entity: ENTITIES.campaign, row: campaignRow }],
      tracker: [],
      unmatchedPixels: [],
    })
    expect(campaignRows).toEqual([
      {
        date: '2026-09-01',
        language: '',
        campaignTag: '',
        metrics: { impressions: 30_000, in_view: 23_500 },
        ctaClicks: [{ ctaId: 'clickthrough', count: 210 }],
        pageViews: [],
        unmapped: new Map(),
      },
    ])
  })
})

describe('Zeus invariants', () => {
  const base = creatives()
  const input = (over: Partial<Parameters<typeof checkZeusInvariants>[0]> = {}) => ({
    creatives: base,
    campaigns: [],
    tracker: tracker(),
    ...over,
  })

  it('passes on the fixture', () => {
    expect(() => {
      checkZeusInvariants(input())
    }).not.toThrow()
  })

  it.each([
    ['clicks > impressions', { clicks: 20_001 }],
    ['visible_impressions > impressions', { visible_impressions: 20_001 }],
    ['unique_impressions > impressions', { unique_impressions: 20_001 }],
    ['unique_clicks > clicks', { unique_clicks: 151 }],
  ])('fails on a creative with %s', (_name, patch) => {
    const [first, ...rest] = base
    if (!first) throw new Error('fixture is empty')
    const broken = [{ entity: first.entity, row: { ...first.row, ...patch } }, ...rest]
    expect(() => {
      checkZeusInvariants(input({ creatives: broken }))
    }).toThrow(ZeusInvariantError)
  })

  it('fails when a creative appears twice for one day', () => {
    expect(() => {
      checkZeusInvariants(input({ creatives: [...base, ...base.slice(0, 1)] }))
    }).toThrow(/appears twice/)
  })

  it('checks the campaigns report too: ratios and duplicate days', () => {
    const campaign = { entity: ENTITIES.campaign, row: campaignRow }
    expect(() => {
      checkZeusInvariants(input({ creatives: [], campaigns: [campaign] }))
    }).not.toThrow()
    expect(() => {
      checkZeusInvariants(
        input({
          creatives: [],
          campaigns: [{ ...campaign, row: { ...campaignRow, clicks: 30_001 } }],
        }),
      )
    }).toThrow(ZeusInvariantError)
    expect(() => {
      checkZeusInvariants(input({ creatives: [], campaigns: [campaign, campaign] }))
    }).toThrow(/appears twice/)
  })

  it('checks the tracker report too: one row per pixel per day', () => {
    const [first, ...rest] = tracker()
    if (!first) throw new Error('fixture is empty')
    expect(() => {
      checkZeusInvariants(input({ tracker: [first, ...rest, first] }))
    }).toThrow(/pixel .* appears twice/)
  })

  it('rejects negative or fractional counts at the schema', () => {
    const raw = loadFixture('tracker').rows[0]
    expect(zeusTrackerRow.safeParse({ ...raw, fires: -1 }).success).toBe(false)
    expect(zeusTrackerRow.safeParse({ ...raw, fires: 1.5 }).success).toBe(false)
  })
})
