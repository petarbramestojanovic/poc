import { describe, expect, it } from 'vitest'
import { eachDay } from '../../../src/core/dates.ts'
import { HttpError } from '../../../src/core/http/HttpClient.ts'
import {
  createZeusConnector,
  ZeusContractError,
} from '../../../src/modules/sync/connectors/zeus/connector.ts'
import { ZeusInvariantError } from '../../../src/modules/sync/connectors/zeus/mapper.ts'
import { createRunMemo } from '../../../src/modules/sync/types.ts'
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
  HAND_SET_ENGAGEMENT,
  httpStatus,
  NOW,
  type Seen,
} from './helpers.ts'

const connector = createZeusConnector({ baseUrl: 'https://zeus.test', now: NOW })
/** The link as provisioning writes it: a campaign id and its creatives, no pixel mapped by hand. */
const BY_RULE = [ENTITIES.campaign, ENTITIES.mpuV1, ENTITIES.mpuV2]

/** The fixture for a report, with only the rows `keep` accepts. */
const fixtureWhere = (keep: (row: Record<string, unknown>) => boolean) => (seen: Seen) => {
  const fixture = fixtureFor(seen)
  return { ...fixture, rows: fixture.rows.filter(keep) }
}
const fromDay = (first: string) => fixtureWhere((row) => (row.date as string) >= first)

describe('Zeus connector', () => {
  it('fetches creatives and campaigns filtered by the campaign id, devices and tracker unfiltered, once per window', async () => {
    const http = fixtureHttp()
    const ctx = context(http)
    const result = await connector.fetchWindow(ctx)
    expect(http.requests).toEqual([
      { report: 'creatives', window: FIXTURE_WINDOW, filter: { external_id: 'camp-ext-1' } },
      { report: 'campaigns', window: FIXTURE_WINDOW, filter: { external_id: 'camp-ext-1' } },
      { report: 'devices', window: FIXTURE_WINDOW, filter: {} },
      { report: 'tracker', window: FIXTURE_WINDOW, filter: {} },
    ])
    expect(http.authHeaders).toEqual([
      'Bearer zeus-token',
      'Bearer zeus-token',
      'Bearer zeus-token',
      'Bearer zeus-token',
    ])
    expect(http.signals.every((s) => s === ctx.signal)).toBe(true)
    expect(result.warnings).toEqual([
      'creatives: rows matched with external_id=camp-ext-1',
      'campaigns: rows matched with external_id=camp-ext-1',
    ])
    expect(result.covered).toEqual(FIXTURE_WINDOW)
    expect(ctx.captures).toHaveLength(4)
    expect(JSON.stringify(ctx.captures)).not.toContain('zeus-token')
    expect(ctx.captures[0]?.request).toEqual({
      method: 'GET',
      url: 'https://zeus.test/api/v1/reports/creatives?from=2026-09-01&to=2026-09-03&external_id=camp-ext-1',
    })
  })

  it('counts each pixel for its creative and leaves another campaign’s pixel alone', async () => {
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
    // Pixel 9999 is somebody else's: no number, no warning, nothing in this link's queue.
    expect(result.rows.every((r) => r.unmapped.size === 0)).toBe(true)
    expect(result.warnings.join('\n')).not.toMatch(/pixel|9999/)
  })

  it('takes engagement from the `eng` pixel that carries a creative’s id, with no pixel on the link', async () => {
    const http = fixtureHttp()
    const result = await connector.fetchWindow(context(http, FIXTURE_WINDOW, BY_RULE))

    expect(http.requests.map((r) => r.report)).toContain('tracker')
    const started = (tag: string) =>
      result.rows.filter((r) => r.campaignTag === tag).map((r) => r.metrics.game_started)
    expect(started('mpu_v1')).toEqual([600, 620, 640])
    // No pixel names V2: its engagement is not measured, which is not 0.
    expect(started('mpu_v2')).toEqual([undefined, undefined, undefined])
    // The finish pixel is nobody's here: it carries no creative's id and nobody mapped it.
    expect(result.rows.every((r) => r.metrics.game_finished === undefined)).toBe(true)
  })

  it('queues a pixel on our creative whose code has no role, warns once, and counts nothing for it', async () => {
    const http = fixtureHttp({
      tracker: (seen) => {
        const fixture = fixtureFor(seen)
        return {
          ...fixture,
          rows: fixture.rows.map((r) => (r.pixel_id === 9001 ? { ...r, code: 'view' } : r)),
        }
      },
    })
    const result = await connector.fetchWindow(context(http, FIXTURE_WINDOW, BY_RULE))

    const label = 'pixel 9001 with code "view" on ENG Swipe MPU V1'
    expect(result.rows.every((r) => r.metrics.game_started === undefined)).toBe(true)
    expect(
      result.rows
        .filter((r) => r.unmapped.size > 0)
        .map((r) => [r.date, r.campaignTag, r.unmapped]),
    ).toEqual([
      ['2026-09-01', '', new Map([[label, 600]])],
      ['2026-09-02', '', new Map([[label, 620]])],
      ['2026-09-03', '', new Map([[label, 640]])],
    ])
    expect(result.warnings.filter((w) => w.startsWith('tracker:'))).toEqual([
      `tracker: ${label} is not counted: nothing says what it counts`,
    ])
  })

  it('never lets a hand-mapped pixel called `eng`, or by a shared external id, claim other pixels', async () => {
    for (const externalId of ['eng', 'ENG Swipe MPU V1']) {
      const result = await connector.fetchWindow(
        context(fixtureHttp(), FIXTURE_WINDOW, [
          ENTITIES.campaign,
          { ...HAND_SET_ENGAGEMENT, externalId },
        ]),
      )
      expect(result.rows.every((r) => r.metrics.game_started === undefined)).toBe(true)
    }
  })

  it('does not count a pixel that carries the campaign’s id: only creatives are named by the rule', async () => {
    const onCampaign = (seen: Seen) => {
      const fixture = fixtureFor(seen)
      return { ...fixture, rows: fixture.rows.map((r) => ({ ...r, external_id: 'camp-ext-1' })) }
    }
    const result = await connector.fetchWindow(
      context(fixtureHttp({ tracker: onCampaign }), FIXTURE_WINDOW, BY_RULE),
    )
    expect(result.rows.every((r) => r.metrics.game_started === undefined)).toBe(true)
    expect(result.rows.every((r) => r.unmapped.size === 0)).toBe(true)
  })

  it('is not stopped by somebody else’s pixel row that it cannot read, only by its own', async () => {
    const junk = (pixelId: number) => (seen: Seen) => {
      const fixture = fixtureFor(seen)
      return {
        ...fixture,
        rows: fixture.rows.map((r) => (r.pixel_id === pixelId ? { ...r, fires: 'many' } : r)),
      }
    }
    const foreign = await connector.fetchWindow(context(fixtureHttp({ tracker: junk(9999) })))
    expect(foreign.rows.filter((r) => r.metrics.game_started !== undefined)).toHaveLength(3)

    await expect(
      connector.fetchWindow(context(fixtureHttp({ tracker: junk(9001) }))),
    ).rejects.toThrow(/Unexpected Zeus tracker row/)
  })

  it('fails the run on a violated invariant', async () => {
    const http = fixtureHttp({
      creatives: (s) => {
        const fixture = fixtureFor(s)
        return { ...fixture, rows: [...fixture.rows, fixture.rows[0]] }
      },
    })
    await expect(connector.fetchWindow(context(http))).rejects.toThrow(ZeusInvariantError)
  })

  it('stores counts above impressions as reported and warns about each', async () => {
    const http = fixtureHttp({
      creatives: (s) => {
        const fixture = fixtureFor(s)
        const rows = fixture.rows.map((r) => ({ ...r }))
        rows[0] = { ...rows[0], clicks: 20_050, visible_impressions: 20_100 }
        return { ...fixture, rows }
      },
    })

    const result = await connector.fetchWindow(context(http))

    const day = result.rows.find((r) => r.date === '2026-09-01' && r.campaignTag === 'mpu_v1')
    expect(day?.metrics).toMatchObject({ impressions: 20_000, in_view: 20_100 })
    expect(day?.ctaClicks).toEqual([{ ctaId: 'clickthrough', count: 20_050 }])
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'creative ENG Swipe MPU V1 on 2026-09-01: Zeus reports clicks 20050 > impressions 20000; stored as reported',
        'creative ENG Swipe MPU V1 on 2026-09-01: Zeus reports visible_impressions 20100 > impressions 20000; stored as reported',
      ]),
    )
  })

  it('stores null unique counts as 0 and a missing one as absent', async () => {
    const http = fixtureHttp({
      campaigns: (s) => {
        const fixture = fixtureFor(s)
        const rows = fixture.rows.map((r) => ({ ...r }))
        rows[0] = { ...rows[0], unique_impressions: null, unique_clicks: null }
        const withoutUniques = { ...rows[1] }
        delete withoutUniques.unique_impressions
        delete withoutUniques.unique_clicks
        rows[1] = withoutUniques
        return { ...fixture, rows }
      },
    })

    const result = await connector.fetchWindow(context(http, FIXTURE_WINDOW, [ENTITIES.campaign]))

    const day = (date: string) => result.rows.find((r) => r.date === date && r.campaignTag === '')
    expect(day('2026-09-01')?.metrics).toMatchObject({
      unique_impressions_reported: 0,
      unique_clicks_reported: 0,
    })
    expect(day('2026-09-02')?.metrics).not.toHaveProperty('unique_impressions_reported')
    expect(day('2026-09-02')?.metrics).not.toHaveProperty('unique_clicks_reported')
  })

  it('stores null unique counts on the creatives report as 0', async () => {
    const http = fixtureHttp({
      creatives: (s) => {
        const fixture = fixtureFor(s)
        const rows = fixture.rows.map((r) => ({ ...r }))
        rows[0] = { ...rows[0], unique_impressions: null, unique_clicks: null }
        return { ...fixture, rows }
      },
    })

    const result = await connector.fetchWindow(context(http))

    const day = result.rows.find((r) => r.date === '2026-09-01' && r.campaignTag === 'mpu_v1')
    expect(day?.metrics).toMatchObject({
      impressions: 20_000,
      unique_impressions_reported: 0,
      unique_clicks_reported: 0,
    })
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
    const http = fixtureHttp({
      creatives: empty,
      campaigns: empty,
      devices: empty,
      tracker: empty,
    })
    const result = await connector.fetchWindow(
      context(http, { from: '2026-07-01', to: '2026-09-10' }),
    )
    for (const report of ['creatives', 'campaigns', 'devices', 'tracker']) {
      expect(http.requests.filter((r) => r.report === report).map((r) => r.window)).toEqual([
        { from: '2026-07-01', to: '2026-07-31' },
        { from: '2026-08-01', to: '2026-08-31' },
        { from: '2026-09-01', to: '2026-09-04' },
      ])
    }
    expect(result.warnings).toContain(
      'Zeus serves complete days only: window end 2026-09-10 clamped to 2026-09-04 (UTC)',
    )
    expect(result.covered).toEqual({ from: '2026-07-01', to: '2026-09-04' })
  })

  it('computes "yesterday" in the source day zone', async () => {
    const http = fixtureHttp({
      creatives: empty,
      campaigns: empty,
      devices: empty,
      tracker: empty,
    })
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

  it('never retries with the other id param, where another campaign can share our id', async () => {
    // Our campaign was quiet. Zeus has a different campaign (777) whose external id happens to
    // be the internal id we typed: asking by external_id would return its rows as ours.
    const http = fixtureHttp({
      campaigns: (s) => {
        if (!s.filter.external_id) return empty(s)
        const fixture = fixtureFor(s)
        return {
          ...fixture,
          rows: fixture.rows.map((r) => ({ ...r, campaign_id: 777, external_id: 'camp-ext-1' })),
        }
      },
    })
    const result = await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, [ENTITIES.campaign], {
        ...DEFAULT_CONFIG,
        campaign_id_param: 'internal_id',
      }),
    )

    // The campaigns report is asked by the id the link typed; the two account-wide reports are
    // not filtered at all, and nothing in them names this link by a Zeus number it does not have.
    expect(http.requests.map((r) => [r.report, r.filter])).toEqual([
      ['campaigns', { internal_id: 'camp-ext-1' }],
      ['devices', {}],
      ['tracker', {}],
    ])
    expect(result.rows).toEqual([])
    // The covered days are still replaced (a quiet campaign is cleared, never kept stale), and
    // the empty answer is visible on the run in case the idType is what is wrong.
    expect(result.covered).toEqual(FIXTURE_WINDOW)
    expect(result.warnings).toEqual([
      "campaigns: no rows for internal_id=camp-ext-1 (if the campaign delivered in this window, check the link's idType)",
    ])
  })

  it('refuses campaign rows that belong to another campaign instead of attributing them to ours', async () => {
    const stranger = (s: Parameters<typeof empty>[0]) => {
      const fixture = fixtureFor(s)
      return {
        ...fixture,
        rows: fixture.rows.map((r) => ({ ...r, campaign_id: 777, external_id: 'other-campaign' })),
      }
    }
    const viaCampaigns = fixtureHttp({ campaigns: stranger })
    await expect(
      connector.fetchWindow(context(viaCampaigns, FIXTURE_WINDOW, [ENTITIES.campaign])),
    ).rejects.toThrow(/belong elsewhere/)

    const viaCreatives = fixtureHttp({ creatives: stranger })
    await expect(connector.fetchWindow(context(viaCreatives))).rejects.toThrow(ZeusContractError)

    const beside = fixtureHttp({ campaigns: stranger })
    await expect(connector.fetchWindow(context(beside))).rejects.toThrow(ZeusContractError)
  })

  it('writes campaign rows only when the link has no creative entity', async () => {
    const result = await connector.fetchWindow(context(fixtureHttp()))
    const impressions = result.rows
      .filter((r) => r.date === '2026-09-01')
      .map((r) => [r.campaignTag, r.metrics.impressions])
    expect(impressions).toEqual(
      expect.arrayContaining([
        ['mpu_v1', 20_000],
        ['mpu_v2', 10_000],
      ]),
    )
    expect(
      result.rows.filter((r) => r.campaignTag === '' && r.metrics.impressions !== undefined),
    ).toEqual([])
  })

  it('cannot compare without a campaign entity: creatives only, as before', async () => {
    const http = fixtureHttp({
      creatives: (seen) =>
        fixtureWhere((row) => String(row.creative_id) === seen.filter.external_id)(seen),
    })
    const result = await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, [ENTITIES.mpuV1, ENTITIES.mpuV2]),
    )
    expect(http.requests.map((r) => r.report)).not.toContain('campaigns')
    expect(result.covered).toEqual(FIXTURE_WINDOW)
  })

  it('leaves the days before Zeus began dividing the campaign as stored, pixel fires included', async () => {
    const http = fixtureHttp({ creatives: fromDay('2026-09-02') })
    const result = await connector.fetchWindow(context(http))
    expect(result.covered).toEqual({ from: '2026-09-02', to: '2026-09-03' })
    expect(result.rows.map((r) => r.date).sort()[0]).toBe('2026-09-02')
    expect(result.warnings).toContain(
      'creatives: 1 day(s) through 2026-09-01 have numbers in the campaigns report and none on a linked creative; left as stored',
    )
  })

  it('claims only the divided days of a Sunday deep pull, across chunks', async () => {
    // Campaign 91: delivering all along, divided into creatives from 2026-10-27.
    const delivery = { impressions: 100, clicks: 5, visible_impressions: 80 }
    const answer = (seen: Seen, first: string, row: Record<string, unknown>) => ({
      from: seen.window.from,
      to: seen.window.to,
      rows: eachDay(seen.window.from, seen.window.to)
        .filter((date) => date >= first)
        .map((date) => ({ date, campaign_id: 91, external_id: 'camp-ext-1', ...delivery, ...row })),
    })
    const http = fixtureHttp({
      campaigns: (seen) => answer(seen, '2026-01-01', {}),
      creatives: (seen) =>
        answer(seen, '2026-10-27', {
          creative_id: ENTITIES.mpuV1.externalId,
          unique_impressions: 90,
          unique_clicks: 4,
        }),
      tracker: empty,
    })
    const sunday = createZeusConnector({
      baseUrl: 'https://zeus.test',
      now: () => new Date('2026-11-08T03:00:00Z'),
    })

    const result = await sunday.fetchWindow(
      context(http, { from: '2026-10-04', to: '2026-11-07' }, [ENTITIES.campaign, ENTITIES.mpuV1]),
    )

    expect(http.requests.filter((r) => r.report === 'campaigns').map((r) => r.window)).toEqual([
      { from: '2026-10-04', to: '2026-11-03' },
      { from: '2026-11-04', to: '2026-11-07' },
    ])
    expect(result.covered).toEqual({ from: '2026-10-27', to: '2026-11-07' })
    expect(result.rows.map((r) => r.date)).toEqual(eachDay('2026-10-27', '2026-11-07'))
    expect(result.warnings).toContain(
      'creatives: 23 day(s) through 2026-10-26 have numbers in the campaigns report and none on a linked creative; left as stored',
    )
  })

  it('still claims, and so clears, a quiet day after the undivided ones', async () => {
    const http = fixtureHttp({
      creatives: fromDay('2026-09-03'),
      campaigns: fixtureWhere((row) => row.date !== '2026-09-02'),
      devices: empty,
      tracker: empty,
    })
    const result = await connector.fetchWindow(context(http))
    expect(result.covered).toEqual({ from: '2026-09-02', to: '2026-09-03' })
    expect(result.rows.filter((r) => r.date === '2026-09-02')).toEqual([])
  })

  it('does not count a campaign row of zeros as a day with numbers', async () => {
    const zeros = (seen: Seen) => {
      const fixture = fixtureFor(seen)
      return {
        ...fixture,
        rows: fixture.rows.map((r) => ({
          ...r,
          impressions: 0,
          clicks: 0,
          visible_impressions: 0,
          unique_impressions: 0,
          unique_clicks: 0,
        })),
      }
    }
    const http = fixtureHttp({
      creatives: empty,
      campaigns: zeros,
      devices: empty,
      tracker: empty,
    })
    const result = await connector.fetchWindow(context(http))
    expect(result.covered).toEqual(FIXTURE_WINDOW)
    expect(result.rows).toEqual([])
  })

  it('fails the run, keeping its payloads, when a divided campaign has a day without creative rows', async () => {
    const http = fixtureHttp({ creatives: fixtureWhere((row) => row.date !== '2026-09-02') })
    const ctx = context(http)
    const failure = connector.fetchWindow(ctx)
    await expect(failure).rejects.toThrow(ZeusInvariantError)
    await expect(failure).rejects.toThrow(/for 2026-09-02 although the campaigns report/)
    expect(ctx.captures.map((c) => c.request.url)).toEqual([
      expect.stringContaining('/reports/creatives'),
      expect.stringContaining('/reports/campaigns'),
      expect.stringContaining('/reports/devices'),
      expect.stringContaining('/reports/tracker'),
    ])
  })

  it('fails the run when the creatives report has nothing for a campaign that delivered', async () => {
    const http = fixtureHttp({ creatives: empty })
    await expect(connector.fetchWindow(context(http))).rejects.toThrow(
      /for 2026-09-01, 2026-09-02, 2026-09-03 although the campaigns report/,
    )
  })

  it('fails the run when every creative that reports is unlinked', async () => {
    const unlinked = (seen: Seen) => {
      const fixture = fixtureFor(seen)
      return {
        ...fixture,
        rows: fixture.rows.map((r) => ({ ...r, creative_id: 'not-on-the-link' })),
      }
    }
    const http = fixtureHttp({ creatives: unlinked })
    await expect(connector.fetchWindow(context(http))).rejects.toThrow(ZeusInvariantError)
  })

  it('checks invariants on the campaigns report it only reads', async () => {
    const twice = (seen: Seen) => {
      const fixture = fixtureFor(seen)
      return { ...fixture, rows: [...fixture.rows, ...fixture.rows] }
    }
    await expect(connector.fetchWindow(context(fixtureHttp({ campaigns: twice })))).rejects.toThrow(
      /appears twice/,
    )
  })

  it('claims only what the campaigns report served too', async () => {
    const http = fixtureHttp({
      campaigns: (seen) =>
        fixtureFor({ ...seen, window: { from: seen.window.from, to: '2026-09-02' } }),
    })
    const result = await connector.fetchWindow(context(http))
    expect(result.covered).toEqual({ from: '2026-09-01', to: '2026-09-02' })
  })

  it('reads the campaigns report, not creatives, for a link with no creative entity', async () => {
    const http = fixtureHttp()
    const result = await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, [ENTITIES.campaign, HAND_SET_ENGAGEMENT]),
    )
    expect(http.requests.map((r) => r.report)).toEqual(['campaigns', 'devices', 'tracker'])
    // The campaign's delivery and its device split are one row: the campaign's own.
    expect(result.rows.find((r) => r.date === '2026-09-01' && r.campaignTag === '')).toMatchObject({
      metrics: {
        impressions: 30_000,
        in_view: 23_500,
        unique_impressions_reported: 25_800,
        unique_clicks_reported: 195,
      },
      ctaClicks: [{ ctaId: 'clickthrough', count: 210 }],
      devices: [
        { deviceType: 'desktop', impressions: 18_000, inView: 14_100, clicks: 126 },
        { deviceType: 'mobile', impressions: 10_000, inView: 7_900, clicks: 70 },
        { deviceType: 'tablet', impressions: 2_000, inView: 1_500, clicks: 14 },
      ],
    })
    // The pixel was mapped by hand to the creative tagged mpu_v1, so its fires land there.
    expect(
      result.rows.find((r) => r.date === '2026-09-01' && r.campaignTag === 'mpu_v1')?.metrics,
    ).toEqual({ game_started: 600 })
  })

  describe('the device split', () => {
    const ownRows = (rows: Awaited<ReturnType<typeof connector.fetchWindow>>['rows']) =>
      rows.filter((r) => r.campaignTag === '')

    it('stores a split campaign’s devices on the campaign’s own row, and nobody else’s', async () => {
      const result = await connector.fetchWindow(context(fixtureHttp()))

      expect(
        ownRows(result.rows).map((r) => [
          r.date,
          r.devices.map((d) => [d.deviceType, d.impressions]),
        ]),
      ).toEqual([
        [
          '2026-09-01',
          [
            ['desktop', 18_000],
            ['mobile', 10_000],
            ['tablet', 2_000],
          ],
        ],
        [
          '2026-09-02',
          [
            ['desktop', 19_000],
            ['mobile', 10_500],
            ['tablet', 2_000],
          ],
        ],
        [
          '2026-09-03',
          [
            ['desktop', 20_000],
            ['mobile', 11_000],
            ['tablet', 2_000],
          ],
        ],
      ])
      // Campaign 777's 500 desktop impressions a day are in the same download and are not ours.
      const all = result.rows.flatMap((r) => r.devices)
      expect(all.reduce((sum, d) => sum + (d.impressions ?? 0), 0)).toBe(30_000 + 31_500 + 33_000)
      expect(
        result.rows.filter((r) => r.campaignTag !== '').every((r) => r.devices.length === 0),
      ).toBe(true)
      // The devices add up to the campaigns report: nothing to warn about.
      expect(result.warnings.filter((w) => w.startsWith('devices'))).toEqual([])
    })

    it('stores a device row that names a creative on that creative', async () => {
      // Zeus as the device split is meant to arrive: each row carries a creative's id.
      const perCreative = (seen: Seen) => {
        const creatives = fixtureFor({ ...seen, report: 'creatives' })
        return {
          ...fixtureFor(seen),
          rows: creatives.rows.flatMap((r) => [
            {
              date: r.date,
              campaign_id: 501,
              external_id: r.creative_id,
              device_type: 'mobile',
              impressions: (r.impressions as number) - 1_000,
              clicks: r.clicks,
              visible_impressions: (r.visible_impressions as number) - 1_000,
            },
            {
              date: r.date,
              campaign_id: 501,
              external_id: r.creative_id,
              device_type: 'desktop',
              impressions: 1_000,
              clicks: 0,
              visible_impressions: 1_000,
            },
          ]),
        }
      }
      const result = await connector.fetchWindow(context(fixtureHttp({ devices: perCreative })))

      expect(
        result.rows
          .filter((r) => r.date === '2026-09-01')
          .map((r) => [r.campaignTag, r.metrics.impressions, r.devices]),
      ).toEqual([
        [
          'mpu_v1',
          20_000,
          [
            { deviceType: 'desktop', impressions: 1_000, inView: 1_000, clicks: 0 },
            { deviceType: 'mobile', impressions: 19_000, inView: 15_000, clicks: 150 },
          ],
        ],
        [
          'mpu_v2',
          10_000,
          [
            { deviceType: 'desktop', impressions: 1_000, inView: 1_000, clicks: 0 },
            { deviceType: 'mobile', impressions: 9_000, inView: 6_500, clicks: 60 },
          ],
        ],
      ])
      expect(result.warnings.filter((w) => w.startsWith('devices'))).toEqual([])
    })

    it('keeps the creative’s rows and leaves the campaign’s out on a day Zeus sends both', async () => {
      const both = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        const forCreative = fixture.rows
          .filter((r) => r.campaign_id === 501 && r.date === '2026-09-02')
          .map((r) => ({ ...r, external_id: ENTITIES.mpuV1.externalId }))
        return { ...fixture, rows: [...fixture.rows, ...forCreative] }
      }
      const result = await connector.fetchWindow(context(fixtureHttp({ devices: both })))

      const split = result.rows
        .filter((r) => r.devices.length > 0)
        .map((r) => [
          r.date,
          r.campaignTag,
          r.devices.reduce((n, d) => n + (d.impressions ?? 0), 0),
        ])
      // 09-02 is counted once, on the creative; the other days stay on the campaign's own row.
      expect(split).toEqual([
        ['2026-09-01', '', 30_000],
        ['2026-09-02', 'mpu_v1', 31_500],
        ['2026-09-03', '', 33_000],
      ])
    })

    it.each(['external_id', 'internal_id'] as const)(
      'never adds a creative the link does not list to the campaign (%s link), and says so',
      async (campaign_id_param) => {
        // Zeus breaks the campaign's devices out per creative; one of them is not on the link.
        const perCreative = (seen: Seen) => {
          const fixture = fixtureFor(seen)
          const ours = fixture.rows.filter((r) => r.campaign_id === 501)
          return {
            ...fixture,
            rows: [
              ...ours.map((r) => ({ ...r, external_id: ENTITIES.mpuV1.externalId })),
              ...ours.map((r) => ({ ...r, external_id: 'a creative nobody linked' })),
            ],
          }
        }
        const campaign = {
          ...ENTITIES.campaign,
          externalId: campaign_id_param === 'internal_id' ? '501' : ENTITIES.campaign.externalId,
        }
        const result = await connector.fetchWindow(
          context(
            fixtureHttp({ devices: perCreative }),
            FIXTURE_WINDOW,
            [campaign, ENTITIES.mpuV1, ENTITIES.mpuV2],
            { ...DEFAULT_CONFIG, campaign_id_param },
          ),
        )

        expect(
          new Set(result.rows.filter((r) => r.devices.length > 0).map((r) => r.campaignTag)),
        ).toEqual(new Set(['mpu_v1']))
        expect(result.warnings).toContain(
          `devices: rows for "a creative nobody linked" in campaign 501 are neither the campaign's own nor a linked creative's; ignored`,
        )
      },
    )

    it('stores the campaign’s own rows once when Zeus also sends rows per creative for it', async () => {
      // A campaign-level link: the campaign's total and its creatives' rows are the same
      // impressions twice. Only the row that carries the campaign's own ids is the campaign's.
      const totalAndParts = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        const ours = fixture.rows.filter((r) => r.campaign_id === 501)
        return {
          ...fixture,
          rows: [...ours, ...ours.map((r) => ({ ...r, external_id: 'ENG Swipe MPU V1' }))],
        }
      }
      const result = await connector.fetchWindow(
        context(fixtureHttp({ devices: totalAndParts }), FIXTURE_WINDOW, [ENTITIES.campaign]),
      )

      const stored = result.rows.flatMap((r) => r.devices)
      expect(stored.reduce((n, d) => n + (d.impressions ?? 0), 0)).toBe(30_000 + 31_500 + 33_000)
      expect(result.warnings.filter((w) => w.startsWith('devices'))).toEqual([
        `devices: rows for "ENG Swipe MPU V1" in campaign 501 are neither the campaign's own nor a linked creative's; ignored`,
      ])
    })

    it('is not stopped by a row of somebody else’s that it cannot read', async () => {
      const foreignJunk = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        const junk = { date: 'not a day', campaign_id: 777, external_id: 777, impressions: null }
        return { ...fixture, rows: [junk, ...fixture.rows] }
      }
      const result = await connector.fetchWindow(context(fixtureHttp({ devices: foreignJunk })))
      expect(result.rows.flatMap((r) => r.devices)).toHaveLength(9)
    })

    it('fails the run on a row of its own that it cannot read', async () => {
      const ownJunk = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        const rows = fixture.rows.map((r) => ({ ...r }))
        rows[0] = { ...rows[0], visible_impressions: null }
        return { ...fixture, rows }
      }
      await expect(
        connector.fetchWindow(context(fixtureHttp({ devices: ownJunk }))),
      ).rejects.toThrow(/Unexpected Zeus devices row/)
    })

    it('fails the run when a row does not say whose it is: the report’s shape changed', async () => {
      const anonymous = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        return { ...fixture, rows: fixture.rows.map(({ campaign_id: _, ...rest }) => rest) }
      }
      await expect(
        connector.fetchWindow(context(fixtureHttp({ devices: anonymous }))),
      ).rejects.toThrow(ZeusContractError)
    })

    it('reads an external id Zeus sends as a number', async () => {
      const numeric = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        return {
          ...fixture,
          rows: fixture.rows.map((r) => (r.campaign_id === 501 ? { ...r, external_id: 501 } : r)),
        }
      }
      const campaigns = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        return { ...fixture, rows: fixture.rows.map((r) => ({ ...r, external_id: '501' })) }
      }
      const result = await connector.fetchWindow(
        context(
          fixtureHttp({ devices: numeric, campaigns }),
          FIXTURE_WINDOW,
          [{ ...ENTITIES.campaign, externalId: '501' }],
          { ...DEFAULT_CONFIG, campaign_id_param: 'internal_id' },
        ),
      )
      expect(result.rows.flatMap((r) => r.devices)).toHaveLength(9)
    })

    it('fails the run, with nothing to write, when the devices report cannot be fetched', async () => {
      const http = fixtureHttp()
      const failing = {
        ...http,
        request: (req: Parameters<typeof http.request>[0]) =>
          req.url.includes('/reports/devices')
            ? Promise.reject(new HttpError(503, req.url, ''))
            : http.request(req),
      }
      await expect(
        connector.fetchWindow(context(failing, FIXTURE_WINDOW, [ENTITIES.campaign])),
      ).rejects.toBeInstanceOf(HttpError)
    })

    it('fails the run on a device row that appears twice', async () => {
      const twice = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        return { ...fixture, rows: [...fixture.rows, fixture.rows[0]] }
      }
      await expect(connector.fetchWindow(context(fixtureHttp({ devices: twice })))).rejects.toThrow(
        /appears twice/,
      )
    })

    it('stores what Zeus reports when the devices do not add up, and says so', async () => {
      const short = (seen: Seen) => {
        const fixture = fixtureFor(seen)
        const rows = fixture.rows.map((r) => ({ ...r }))
        rows[0] = { ...rows[0], impressions: 17_000 }
        return { ...fixture, rows }
      }
      const result = await connector.fetchWindow(context(fixtureHttp({ devices: short })))

      expect(ownRows(result.rows)[0]?.devices[0]).toMatchObject({
        deviceType: 'desktop',
        impressions: 17_000,
      })
      expect(result.warnings).toContain(
        'devices: camp-ext-1 on 2026-09-01: the device rows add up to 29000 impressions, the campaigns report has 30000; stored as reported',
      )
    })

    it('keeps the delivery of a campaign Zeus has no device rows for', async () => {
      const result = await connector.fetchWindow(context(fixtureHttp({ devices: empty })))

      expect(result.covered).toEqual(FIXTURE_WINDOW)
      expect(result.rows.flatMap((r) => r.devices)).toEqual([])
      expect(result.rows.filter((r) => r.metrics.impressions !== undefined)).toHaveLength(6)
    })

    it('leaves the device rows of the days before Zeus divided the campaign as stored', async () => {
      const result = await connector.fetchWindow(
        context(fixtureHttp({ creatives: fromDay('2026-09-02') })),
      )
      expect(result.covered).toEqual({ from: '2026-09-02', to: '2026-09-03' })
      expect(ownRows(result.rows).map((r) => r.date)).toEqual(['2026-09-02', '2026-09-03'])
    })

    it('rejects a devices answer of an unexpected shape, keeping the payloads fetched before it', async () => {
      const ctx = context(fixtureHttp({ devices: () => ({ rows: 'nope' }) }))
      await expect(connector.fetchWindow(ctx)).rejects.toThrow(ZeusContractError)
      expect(ctx.captures).toHaveLength(2)
    })

    it('narrows every link that reads the shared devices report to the last day Zeus served', async () => {
      const through0902 = (s: Seen) =>
        fixtureFor({ ...s, window: { from: s.window.from, to: '2026-09-02' } })
      const http = fixtureHttp({ devices: through0902 })
      const memo = createRunMemo()
      const run = (linkId: string) =>
        connector.fetchWindow(
          context(http, FIXTURE_WINDOW, ALL_ENTITIES, DEFAULT_CONFIG, { memo, linkId }),
        )

      const a = await run('a')
      const b = await run('b')

      expect(http.requests.filter((r) => r.report === 'devices')).toHaveLength(1)
      for (const result of [a, b]) {
        expect(result.covered).toEqual({ from: '2026-09-01', to: '2026-09-02' })
        expect(result.rows.every((r) => r.date <= '2026-09-02')).toBe(true)
      }
    })
  })

  it('downloads the two unfiltered reports once for every link sharing a run memo', async () => {
    const http = fixtureHttp()
    const memo = createRunMemo()
    await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, ALL_ENTITIES, DEFAULT_CONFIG, { memo, linkId: 'a' }),
    )
    await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, ALL_ENTITIES, DEFAULT_CONFIG, { memo, linkId: 'b' }),
    )
    expect(http.requests.filter((r) => r.report === 'tracker')).toHaveLength(1)
    expect(http.requests.filter((r) => r.report === 'devices')).toHaveLength(1)
    expect(http.requests.filter((r) => r.report === 'creatives')).toHaveLength(2)
  })

  it('narrows every link that reads the shared tracker to the last day Zeus served', async () => {
    // Zeus has not closed 09-03 for the tracker yet, while creatives are complete. Link b reads
    // the tracker from the memo; it must not claim 09-03 either, or that day would be written
    // without its pixel fires and marked complete.
    const trackerThrough0902 = (s: Parameters<typeof empty>[0]) =>
      fixtureFor({ ...s, window: { from: s.window.from, to: '2026-09-02' } })
    const http = fixtureHttp({ tracker: trackerThrough0902 })
    const memo = createRunMemo()
    const run = (linkId: string) =>
      connector.fetchWindow(
        context(http, FIXTURE_WINDOW, ALL_ENTITIES, DEFAULT_CONFIG, { memo, linkId }),
      )

    const a = await run('a')
    const b = await run('b')

    expect(http.requests.filter((r) => r.report === 'tracker')).toHaveLength(1)
    for (const result of [a, b]) {
      expect(result.covered).toEqual({ from: '2026-09-01', to: '2026-09-02' })
      expect(result.rows.every((r) => r.date <= '2026-09-02')).toBe(true)
      expect(result.warnings).toContain(
        'Zeus served some reports only through 2026-09-02; 2026-09-03..2026-09-03 is left for the next run',
      )
    }
  })

  it('covers nothing when Zeus served none of the requested days', async () => {
    const http = fixtureHttp({
      campaigns: (s) => ({ from: s.window.from, to: '2026-08-31', rows: [] }),
    })
    const result = await connector.fetchWindow(
      context(http, { from: '2026-09-01', to: '2026-09-01' }, [ENTITIES.campaign]),
    )
    expect(result).toMatchObject({ rows: [], covered: null })
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
        external_id: 'ENG Swipe MPU V1',
        code: 'eng',
        name: 'ENG Swipe MPU V1 engagement',
        fires_last_7_days: 1_860,
      },
      {
        pixel_id: '9002',
        external_id: '1823cb',
        code: 'fin',
        name: 'ENG Swipe MPU V1 finish',
        fires_last_7_days: 900,
      },
      {
        pixel_id: '9999',
        external_id: 'zz99',
        code: 'eng',
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
