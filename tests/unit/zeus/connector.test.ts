import { describe, expect, it } from 'vitest'
import {
  createZeusConnector,
  matchPixel,
  ZeusContractError,
} from '../../../src/sync/connectors/zeus/connector.ts'
import { ZeusInvariantError } from '../../../src/sync/connectors/zeus/mapper.ts'
import {
  ALL_ENTITIES,
  context,
  ENTITIES,
  FIXTURE_WINDOW,
  fixtureHttp,
  loadFixture,
  NOW,
} from './helpers.ts'

const connector = createZeusConnector({ baseUrl: 'https://zeus.test', now: NOW })

describe('Zeus connector', () => {
  it('fetches creatives filtered by the campaign id and tracker unfiltered, once per window', async () => {
    const http = fixtureHttp()
    const result = await connector.fetchWindow(context(http))
    expect(http.requests).toEqual([
      { report: 'creatives', window: FIXTURE_WINDOW, filter: { external_id: 'camp-ext-1' } },
      { report: 'tracker', window: FIXTURE_WINDOW, filter: {} },
    ])
    expect(http.authHeaders).toEqual(['Bearer zeus-token', 'Bearer zeus-token'])
    expect(result.warnings).toEqual([])
    expect(result.raw).toHaveLength(2)
    expect(JSON.stringify(result.raw)).not.toContain('zeus-token')
    expect(result.raw[0]?.request).toEqual({
      method: 'GET',
      url: 'https://zeus.test/api/v1/reports/creatives?from=2026-09-01&to=2026-09-03&external_id=camp-ext-1',
    })
  })

  it('attributes fires to the right campaign_tag and reports the unmatched pixel in unmapped', async () => {
    const result = await connector.fetchWindow(context(fixtureHttp()))
    const v1 = result.rows.filter((r) => r.campaignTag === 'mpu_v1')
    expect(
      v1.map((r) => [
        r.date,
        r.metrics.impressions,
        r.metrics.game_started,
        r.metrics.game_finished,
      ]),
    ).toEqual([
      ['2026-09-01', 20_000, 600, 290],
      ['2026-09-02', 21_000, 620, 300],
      ['2026-09-03', 22_000, 640, 310],
    ])
    const untagged = result.rows.filter((r) => r.campaignTag === '')
    expect(untagged.map((r) => r.unmapped)).toEqual([
      { 'pixel 9999 "Other campaign pixel"': 40 },
      { 'pixel 9999 "Other campaign pixel"': 40 },
      { 'pixel 9999 "Other campaign pixel"': 40 },
    ])
  })

  it('fails the run on a violated invariant', async () => {
    const http = fixtureHttp({
      creatives: () => {
        const fixture = loadFixture('creatives')
        const rows = fixture.rows.map((r) => ({ ...r }))
        rows[0] = { ...rows[0], clicks: 999_999 }
        return { ...fixture, rows }
      },
    })
    await expect(connector.fetchWindow(context(http))).rejects.toThrow(ZeusInvariantError)
  })

  it('chunks to ≤31 days and clamps the window end to yesterday', async () => {
    const http = fixtureHttp({
      creatives: (s) => ({ from: s.window.from, to: s.window.to, rows: [] }),
      tracker: (s) => ({ from: s.window.from, to: s.window.to, rows: [] }),
    })
    const result = await connector.fetchWindow(
      context(http, { from: '2026-07-01', to: '2026-09-10' }),
    )
    expect(http.requests.filter((r) => r.report === 'tracker').map((r) => r.window)).toEqual([
      { from: '2026-07-01', to: '2026-07-31' },
      { from: '2026-08-01', to: '2026-08-31' },
      { from: '2026-09-01', to: '2026-09-04' },
    ])
    expect(result.warnings).toContain(
      'Zeus serves complete days only: window end 2026-09-10 clamped to 2026-09-04',
    )
  })

  it('falls back from external_id to internal_id when the first filter matches nothing', async () => {
    const http = fixtureHttp({
      creatives: (s) =>
        s.filter.internal_id
          ? loadFixture('creatives')
          : { from: s.window.from, to: s.window.to, rows: [] },
    })
    const result = await connector.fetchWindow(context(http))
    expect(http.requests.map((r) => r.filter)).toEqual([
      { external_id: 'camp-ext-1' },
      { internal_id: 'camp-ext-1' },
      {},
    ])
    expect(result.warnings).toEqual([
      'creatives: no rows for external_id=camp-ext-1, matched with internal_id instead',
    ])
    expect(result.rows.filter((r) => r.campaignTag === 'mpu_v1')).toHaveLength(3)
  })

  it('uses the campaigns report only when the link has no creative entity', async () => {
    const http = fixtureHttp()
    const result = await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, [ENTITIES.campaign, ENTITIES.engagement]),
    )
    expect(http.requests.map((r) => r.report)).toEqual(['campaigns', 'tracker'])
    expect(result.rows.find((r) => r.date === '2026-09-01' && r.campaignTag === '')).toMatchObject({
      metrics: {
        impressions: 30_000,
        in_view: 23_500,
        unique_impressions_reported: 25_800,
        unique_clicks_reported: 195,
      },
      ctaClicks: [{ ctaId: 'clickthrough', count: 210 }],
    })
    // The engagement pixel's tag is mpu_v1, so its fires land on their own tagged row.
    expect(
      result.rows.find((r) => r.date === '2026-09-01' && r.campaignTag === 'mpu_v1')?.metrics,
    ).toEqual({ game_started: 600 })
  })

  it('matches pixels by code, then external_id, then name', () => {
    const pixels = [
      { ...ENTITIES.engagement, externalId: 'by-code' },
      { ...ENTITIES.finish, externalId: 'by-ext' },
      { ...ENTITIES.finish, externalId: 'by-name' },
    ]
    const row = { date: '2026-09-01', pixel_id: '1', fires: 1 }
    expect(
      matchPixel({ ...row, code: 'by-code', external_id: 'by-ext', name: 'by-name' }, pixels)
        ?.externalId,
    ).toBe('by-code')
    expect(
      matchPixel({ ...row, code: 'x', external_id: 'by-ext', name: 'by-name' }, pixels)?.externalId,
    ).toBe('by-ext')
    expect(
      matchPixel({ ...row, code: null, external_id: null, name: 'by-name' }, pixels)?.externalId,
    ).toBe('by-name')
    expect(matchPixel({ ...row, code: 'x', external_id: 'y', name: 'z' }, pixels)).toBeUndefined()
  })

  it('rejects a link config without the clickthrough CTA and an unexpected response shape', async () => {
    await expect(
      connector.fetchWindow(context(fixtureHttp(), FIXTURE_WINDOW, ALL_ENTITIES, {})),
    ).rejects.toThrow()
    const bad = fixtureHttp({ creatives: () => ({ rows: 'nope' }) })
    await expect(connector.fetchWindow(context(bad))).rejects.toThrow(ZeusContractError)
  })

  it('lists pixels with fires over the last 7 days for onboarding', async () => {
    const http = fixtureHttp({ tracker: () => loadFixture('tracker') })
    const pixels = await connector.listPixels(context(http))
    expect(http.requests).toEqual([
      { report: 'tracker', window: { from: '2026-08-29', to: '2026-09-04' }, filter: {} },
    ])
    expect(pixels).toEqual([
      {
        pixel_id: '9001',
        external_id: '1823ca',
        code: 'dev1eng',
        name: 'ENG Swipe MPU V1 engagement',
        fires_last_7_days: 1_860,
      },
      {
        pixel_id: '9002',
        external_id: '1823cb',
        code: 'dev1fin',
        name: 'ENG Swipe MPU V1 finish',
        fires_last_7_days: 900,
      },
      {
        pixel_id: '9999',
        external_id: 'zz99',
        code: 'otherpx',
        name: 'Other campaign pixel',
        fires_last_7_days: 120,
      },
    ])
  })
})
