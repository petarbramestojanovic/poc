import { describe, expect, it } from 'vitest'
import {
  createZeusConnector,
  matchPixel,
  ZeusContractError,
} from '../../../src/sync/connectors/zeus/connector.ts'
import { ZeusInvariantError } from '../../../src/sync/connectors/zeus/mapper.ts'
import { createRunMemo } from '../../../src/sync/types.ts'
import {
  ALL_ENTITIES,
  connection,
  context,
  DEFAULT_CONFIG,
  empty,
  ENTITIES,
  FIXTURE_WINDOW,
  fixtureFor,
  fixtureHttp,
  httpStatus,
  NOW,
} from './helpers.ts'

const connector = createZeusConnector({ baseUrl: 'https://zeus.test', now: NOW })
const UNMATCHED = 'pixel 9999 "Other campaign pixel"'

describe('Zeus connector', () => {
  it('fetches creatives filtered by the campaign id and tracker unfiltered, once per window', async () => {
    const http = fixtureHttp()
    const ctx = context(http)
    const result = await connector.fetchWindow(ctx)
    expect(http.requests).toEqual([
      { report: 'creatives', window: FIXTURE_WINDOW, filter: { external_id: 'camp-ext-1' } },
      { report: 'tracker', window: FIXTURE_WINDOW, filter: {} },
    ])
    expect(http.authHeaders).toEqual(['Bearer zeus-token', 'Bearer zeus-token'])
    expect(http.signals.every((s) => s === ctx.signal)).toBe(true)
    expect(result.warnings).toEqual(['creatives: rows matched with external_id=camp-ext-1'])
    expect(result.covered).toEqual(FIXTURE_WINDOW)
    expect(ctx.captures).toHaveLength(2)
    expect(JSON.stringify(ctx.captures)).not.toContain('zeus-token')
    expect(ctx.captures[0]?.request).toEqual({
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
      new Map([[UNMATCHED, 40]]),
      new Map([[UNMATCHED, 40]]),
      new Map([[UNMATCHED, 40]]),
    ])
  })

  it('fails the run on a violated invariant', async () => {
    const http = fixtureHttp({
      creatives: (s) => {
        const fixture = fixtureFor(s)
        const rows = fixture.rows.map((r) => ({ ...r }))
        rows[0] = { ...rows[0], clicks: 999_999 }
        return { ...fixture, rows }
      },
    })
    await expect(connector.fetchWindow(context(http))).rejects.toThrow(ZeusInvariantError)
  })

  it('stores unique clicks above clicks as reported and warns about the contradiction', async () => {
    const http = fixtureHttp({
      campaigns: (s) => {
        const fixture = fixtureFor(s)
        const rows = fixture.rows.map((r) => ({ ...r }))
        rows[0] = { ...rows[0], clicks: 294, unique_clicks: 297 }
        return { ...fixture, rows }
      },
    })

    const result = await connector.fetchWindow(context(http, FIXTURE_WINDOW, [ENTITIES.campaign]))

    const day = result.rows.find((r) => r.date === '2026-09-01' && r.campaignTag === '')
    expect(day?.metrics).toMatchObject({ unique_clicks_reported: 297 })
    expect(day?.ctaClicks).toEqual([{ ctaId: 'clickthrough', count: 294 }])
    expect(result.warnings).toContain(
      'campaign 501 on 2026-09-01: Zeus reports unique_clicks 297 > clicks 294; stored as reported',
    )
  })

  it('rejects rows with an impossible calendar date', async () => {
    const http = fixtureHttp({
      creatives: (s) => {
        const fixture = fixtureFor(s)
        return { ...fixture, rows: [{ ...fixture.rows[0], date: '2026-02-31' }] }
      },
    })
    await expect(connector.fetchWindow(context(http))).rejects.toThrow(ZeusContractError)
  })

  it('chunks to ≤31 days and clamps the window end to yesterday', async () => {
    const http = fixtureHttp({ creatives: empty, tracker: empty })
    const result = await connector.fetchWindow(
      context(http, { from: '2026-07-01', to: '2026-09-10' }),
    )
    expect(http.requests.filter((r) => r.report === 'tracker').map((r) => r.window)).toEqual([
      { from: '2026-07-01', to: '2026-07-31' },
      { from: '2026-08-01', to: '2026-08-31' },
      { from: '2026-09-01', to: '2026-09-04' },
    ])
    expect(result.warnings).toContain(
      'Zeus serves complete days only: window end 2026-09-10 clamped to 2026-09-04 (UTC)',
    )
    expect(result.covered).toEqual({ from: '2026-07-01', to: '2026-09-04' })
  })

  it('computes "yesterday" in the source day zone', async () => {
    const http = fixtureHttp({ creatives: empty, tracker: empty })
    // 10:00 UTC on 5 Sept is already 6 Sept on Kiritimati (UTC+14), so yesterday there is 5 Sept.
    const result = await connector.fetchWindow(
      context(http, { from: '2026-09-01', to: '2026-09-10' }, ALL_ENTITIES, DEFAULT_CONFIG, {
        dayTimezone: 'Pacific/Kiritimati',
      }),
    )
    expect(result.covered).toEqual({ from: '2026-09-01', to: '2026-09-05' })
  })

  it('covers nothing when the whole window is after the newest complete day', async () => {
    const http = fixtureHttp()
    const result = await connector.fetchWindow(
      context(http, { from: '2026-09-07', to: '2026-09-08' }),
    )
    expect(result).toMatchObject({ rows: [], covered: null })
    expect(http.requests).toEqual([])
  })

  it('narrows the covered window when Zeus clamps the end itself', async () => {
    const clamp = (s: Parameters<typeof empty>[0]) => ({
      ...fixtureFor({ ...s, window: { from: s.window.from, to: '2026-09-02' } }),
    })
    const http = fixtureHttp({ creatives: clamp, tracker: clamp })
    const result = await connector.fetchWindow(context(http))
    expect(result.covered).toEqual({ from: '2026-09-01', to: '2026-09-02' })
    expect(new Set(result.rows.map((r) => r.date))).toEqual(new Set(['2026-09-01', '2026-09-02']))
  })

  it('rejects an answer for a window other than the one requested', async () => {
    const http = fixtureHttp({ creatives: (s) => ({ ...fixtureFor(s), from: '2026-08-01' }) })
    await expect(connector.fetchWindow(context(http))).rejects.toThrow(/answered for/)
  })

  it('falls back from external_id to internal_id when the first filter matches nothing', async () => {
    const http = fixtureHttp({
      creatives: (s) => (s.filter.internal_id ? fixtureFor(s) : empty(s)),
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

  it('refuses campaign rows that belong to another campaign instead of attributing them to ours', async () => {
    const stranger = (s: Parameters<typeof empty>[0]) => {
      const fixture = fixtureFor(s)
      return {
        ...fixture,
        rows: fixture.rows.map((r) => ({ ...r, campaign_id: 777, external_id: 'other-campaign' })),
      }
    }
    const viaCampaigns = fixtureHttp({
      campaigns: (s) => (s.filter.internal_id ? stranger(s) : empty(s)),
    })
    await expect(
      connector.fetchWindow(context(viaCampaigns, FIXTURE_WINDOW, [ENTITIES.campaign])),
    ).rejects.toThrow(/belong elsewhere/)

    const viaCreatives = fixtureHttp({ creatives: stranger })
    await expect(connector.fetchWindow(context(viaCreatives))).rejects.toThrow(ZeusContractError)
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

  it('downloads the unfiltered tracker report once for every link sharing a run memo', async () => {
    const http = fixtureHttp()
    const memo = createRunMemo()
    await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, ALL_ENTITIES, DEFAULT_CONFIG, { memo, linkId: 'a' }),
    )
    await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, ALL_ENTITIES, DEFAULT_CONFIG, { memo, linkId: 'b' }),
    )
    expect(http.requests.filter((r) => r.report === 'tracker')).toHaveLength(1)
    expect(http.requests.filter((r) => r.report === 'creatives')).toHaveLength(2)
  })

  it('makes no request once the run signal is aborted', async () => {
    const http = fixtureHttp()
    const controller = new AbortController()
    controller.abort(new Error('SIGTERM'))
    await expect(
      connector.fetchWindow(
        context(http, FIXTURE_WINDOW, ALL_ENTITIES, DEFAULT_CONFIG, { signal: controller.signal }),
      ),
    ).rejects.toThrow('SIGTERM')
    expect(http.requests).toEqual([])
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

  it('describes the link config schema and rejects an unexpected response shape', async () => {
    const schema = connector.describe().configSchema
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.parse({ clickthrough_cta_id: 'c' })).toEqual({
      clickthrough_cta_id: 'c',
      campaign_id_param: 'external_id',
    })
    const bad = fixtureHttp({ creatives: () => ({ rows: 'nope' }) })
    await expect(connector.fetchWindow(context(bad))).rejects.toThrow(ZeusContractError)
  })

  it('lists pixels with fires over the last 7 days for onboarding', async () => {
    const http = fixtureHttp({
      tracker: (s) => ({
        ...fixtureFor({ ...s, window: { from: '2026-01-01', to: '2026-12-31' } }),
        from: s.window.from,
        to: s.window.to,
      }),
    })
    const pixels = await connector.listPixels(connection(http))
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

describe('Zeus checkConnection', () => {
  it('accepts a working token', async () => {
    await expect(connector.checkConnection(connection(fixtureHttp()))).resolves.toMatchObject({
      ok: true,
    })
  })

  it.each([
    [401, 'rejected the token'],
    [403, 'rejected the token'],
    [429, 'not answering normally'],
    [503, 'not answering normally'],
  ])('HTTP %i is not ok', async (status, message) => {
    const check = await connector.checkConnection(connection(httpStatus(status)))
    expect(check.ok).toBe(false)
    expect(check.message).toContain(message)
  })
})
