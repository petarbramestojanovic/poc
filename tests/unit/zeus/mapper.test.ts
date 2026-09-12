import { describe, expect, it } from 'vitest'
import {
  checkZeusInvariants,
  mapZeusRows,
  ZeusInvariantError,
  type Matched,
} from '../../../src/sync/connectors/zeus/mapper.ts'
import {
  zeusCreativesRow,
  zeusTrackerRow,
  type ZeusCreativesRow,
} from '../../../src/sync/connectors/zeus/schema.ts'
import { ENTITIES, loadFixture } from './helpers.ts'

const creatives = (): Matched<ZeusCreativesRow>[] =>
  loadFixture('creatives').rows.map((raw) => {
    const row = zeusCreativesRow.parse(raw)
    return { entity: row.creative_id === '12345' ? ENTITIES.mpuV1 : ENTITIES.mpuV2, row }
  })

const tracker = () =>
  loadFixture('tracker')
    .rows.map((raw) => zeusTrackerRow.parse(raw))
    .filter((row) => row.code !== 'otherpx')
    .map((row) => ({ entity: row.code === 'dev1eng' ? ENTITIES.engagement : ENTITIES.finish, row }))

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
    expect(rows[0]).toMatchObject({
      campaignTag: '',
      metrics: {},
      unmapped: { 'pixel 9999 "Other campaign pixel"': 40 },
    })
  })

  it('uses the campaigns report the same way when a link has no creatives', () => {
    const campaignRows = mapZeusRows({
      language: '',
      clickthroughCtaId: 'clickthrough',
      creatives: [],
      campaigns: [
        {
          entity: ENTITIES.campaign,
          row: {
            date: '2026-09-01',
            campaign_id: '501',
            impressions: 30_000,
            clicks: 210,
            visible_impressions: 23_500,
          },
        },
      ],
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
        unmapped: {},
      },
    ])
  })
})

describe('Zeus invariants', () => {
  const base = creatives()

  it('passes on the fixture', () => {
    expect(() => {
      checkZeusInvariants(base)
    }).not.toThrow()
  })

  it.each([
    ['clicks > impressions', { clicks: 20_001 }],
    ['visible_impressions > impressions', { visible_impressions: 20_001 }],
    ['unique_impressions > impressions', { unique_impressions: 20_001 }],
  ])('fails on %s', (_name, patch) => {
    const [first, ...rest] = base
    if (!first) throw new Error('fixture is empty')
    const broken = [{ entity: first.entity, row: { ...first.row, ...patch } }, ...rest]
    expect(() => {
      checkZeusInvariants(broken)
    }).toThrow(ZeusInvariantError)
  })

  it('fails when a creative appears twice for one day', () => {
    expect(() => {
      checkZeusInvariants([...base, ...base.slice(0, 1)])
    }).toThrow(/appears twice/)
  })
})
