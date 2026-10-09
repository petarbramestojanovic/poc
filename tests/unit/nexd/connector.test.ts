import { describe, expect, it } from 'vitest'
import { NetworkError } from '../../../src/core/http/HttpClient.ts'
import {
  createNexdConnector,
  NexdContractError,
  NexdVerificationError,
} from '../../../src/modules/sync/connectors/nexd/connector.ts'
import {
  connection,
  context,
  entity,
  failingHttp,
  fakeHttp,
  FIXTURE_WINDOW,
  httpStatus,
  KNOWN_TOTALS,
  loadFixture,
  syntheticResponse,
} from './helpers.ts'

const NOW = () => new Date('2026-09-10T10:00:00Z')
const connector = createNexdConnector({ baseUrl: 'https://nexd.test', now: NOW })

const sumMetric = (rows: { metrics: Record<string, number | undefined> }[], id: string) =>
  rows.reduce((acc, r) => acc + (r.metrics[id] ?? 0), 0)

describe('NEXD connector', () => {
  it('fetches one request per live_id, authenticates, captures and maps the fixture', async () => {
    const http = fakeHttp(() => loadFixture())
    const ctx = context(http, FIXTURE_WINDOW)
    const result = await connector.fetchWindow(ctx)

    expect(http.requests).toEqual([
      { url: 'https://nexd.test/analytics/creatives/nx_1', window: FIXTURE_WINDOW },
    ])
    expect(http.meta[0]?.signal).toBe(ctx.signal)
    expect(http.meta[0]?.log).toBe(ctx.log)
    expect(result.rows).toHaveLength(7)
    expect(result.covered).toEqual(FIXTURE_WINDOW)
    expect(sumMetric(result.rows, 'impressions')).toBe(KNOWN_TOTALS.impressions)
    expect(sumMetric(result.rows, 'interactions')).toBe(KNOWN_TOTALS.interactions)
    expect(result.warnings).toEqual([])
    expect(ctx.captures).toHaveLength(1)
    expect(ctx.captures[0]?.request).toEqual({
      method: 'POST',
      url: 'https://nexd.test/analytics/creatives/nx_1',
      body: {
        base: 'impressions',
        startDate: Date.UTC(2026, 7, 31) / 1000,
        endDate: Date.UTC(2026, 8, 6, 23, 59, 59) / 1000,
        traffic: 'all',
        device: 'all',
        incvtr: true,
      },
    })
    expect(JSON.stringify(ctx.captures)).not.toContain('test-key')
  })

  it('computes the request day boundaries in the source day zone, not UTC', async () => {
    const http = fakeHttp(() => loadFixture())
    const ctx = context(http, FIXTURE_WINDOW, [entity('nx_1')], { dayTimezone: 'Europe/Zurich' })
    await connector.fetchWindow(ctx)
    expect(ctx.captures[0]?.request.body).toMatchObject({
      startDate: Date.UTC(2026, 7, 30, 22) / 1000,
      endDate: Date.UTC(2026, 8, 6, 21, 59, 59) / 1000,
    })
  })

  it('gives every live_id its own campaign_tag rows', async () => {
    const http = fakeHttp(() => loadFixture())
    const result = await connector.fetchWindow(
      context(http, FIXTURE_WINDOW, [entity('nx_1', 'v1'), entity('nx_2', 'v2')]),
    )
    expect(http.requests.map((r) => r.url)).toEqual([
      'https://nexd.test/analytics/creatives/nx_1',
      'https://nexd.test/analytics/creatives/nx_2',
    ])
    expect(result.rows.filter((r) => r.campaignTag === 'v1')).toHaveLength(7)
    expect(result.rows.filter((r) => r.campaignTag === 'v2')).toHaveLength(7)
  })

  it('chunks long windows into ≤21-day requests and covers every day once', async () => {
    const http = fakeHttp((_req, window) => syntheticResponse(window))
    const window = { from: '2026-07-01', to: '2026-08-14' } // 45 days
    const result = await connector.fetchWindow(context(http, window))
    expect(http.requests.map((r) => r.window)).toEqual([
      { from: '2026-07-01', to: '2026-07-21' },
      { from: '2026-07-22', to: '2026-08-11' },
      { from: '2026-08-12', to: '2026-08-14' },
    ])
    expect(result.rows).toHaveLength(45)
    expect(new Set(result.rows.map((r) => r.date)).size).toBe(45)
    expect(sumMetric(result.rows, 'interactions')).toBe(45 * 5)
  })

  it('contract: falls back to one request per day reading events[] when eventsList is missing', async () => {
    const fixture = loadFixture()
    const analytics = (fixture.result as { analytics: Record<string, unknown> }).analytics
    delete analytics.eventsList

    const http = fakeHttp(() => fixture)
    const ctx = context(http, FIXTURE_WINDOW)
    const result = await connector.fetchWindow(ctx)

    // 1 window request + 7 per-day requests: the fallback path was exercised.
    expect(http.requests).toHaveLength(8)
    expect(http.requests.slice(1).map((r) => r.window)).toEqual(
      [
        '2026-08-31',
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
        '2026-09-04',
        '2026-09-05',
        '2026-09-06',
      ].map((d) => ({ from: d, to: d })),
    )
    expect(result.warnings).toEqual([
      'live_id nx_1: eventsList missing, fell back to one request per day',
    ])
    expect(ctx.captures).toHaveLength(8)
    // The fixture's range-total events[] are served for every day, so the per-day interaction
    // count equals the range total; what matters here is that events reached the rows at all.
    expect(result.rows.every((r) => (r.metrics.interactions ?? 0) > 0)).toBe(true)
  })

  it('contract: fails loudly when neither eventsList nor events[] is present', async () => {
    const fixture = loadFixture()
    const analytics = (fixture.result as { analytics: Record<string, unknown> }).analytics
    delete analytics.eventsList
    delete analytics.events
    await expect(
      connector.fetchWindow(
        context(
          fakeHttp(() => fixture),
          FIXTURE_WINDOW,
        ),
      ),
    ).rejects.toThrow(NexdContractError)
  })

  it('fails the run when written days do not add up to summary.totals, keeping the captured payload', async () => {
    const fixture = loadFixture()
    const analytics = (
      fixture.result as { analytics: { summary: { totals: { impressions: number } } } }
    ).analytics
    analytics.summary.totals.impressions += 1
    const ctx = context(
      fakeHttp(() => fixture),
      FIXTURE_WINDOW,
    )
    await expect(connector.fetchWindow(ctx)).rejects.toThrow(NexdVerificationError)
    expect(ctx.captures).toHaveLength(1)
  })

  it('fails when the returned days are not consecutive', async () => {
    const fixture = loadFixture()
    const analytics = (fixture.result as { analytics: { performance: unknown[] } }).analytics
    analytics.performance.splice(3, 1)
    await expect(
      connector.fetchWindow(
        context(
          fakeHttp(() => fixture),
          FIXTURE_WINDOW,
        ),
      ),
    ).rejects.toThrow(/not consecutive/)
  })

  it('rejects an unexpected response shape', async () => {
    const http = fakeHttp(() => ({
      result: { analytics: { performance: [{ impressions: 'many' }] } },
    }))
    await expect(connector.fetchWindow(context(http, FIXTURE_WINDOW))).rejects.toThrow(
      NexdContractError,
    )
  })

  it('makes no further request once the run signal is aborted', async () => {
    const http = fakeHttp(() => loadFixture())
    const controller = new AbortController()
    controller.abort(new Error('SIGTERM'))
    await expect(
      connector.fetchWindow(
        context(http, FIXTURE_WINDOW, [entity('nx_1')], { signal: controller.signal }),
      ),
    ).rejects.toThrow('SIGTERM')
    expect(http.requests).toHaveLength(0)
  })

  it('describes an empty strict link config', () => {
    expect(connector.describe().configSchema.safeParse({}).success).toBe(true)
    expect(connector.describe().configSchema.safeParse({ liveIds: [] }).success).toBe(false)
  })
})

describe('NEXD checkConnection', () => {
  it.each([
    [401, false, 'rejected the API key'],
    [403, false, 'rejected the API key'],
    [404, true, 'accepted the API key'],
    [429, false, 'not answering normally'],
    [500, false, 'not answering normally'],
    [503, false, 'not answering normally'],
  ])('HTTP %i → ok=%s', async (status, ok, message) => {
    const http = httpStatus(status)
    const check = await connector.checkConnection(connection(http))
    expect(check.ok).toBe(ok)
    expect(check.message).toContain(message)
    expect(http.meta[0]?.deadlineMs).toBe(20_000)
  })

  it('treats a 2xx with an unexpected body as an accepted key', async () => {
    const check = await connector.checkConnection(connection(fakeHttp(() => ({ nope: true }))))
    expect(check.ok).toBe(true)
  })

  it('rethrows failures that say nothing about the key', async () => {
    const http = failingHttp(new NetworkError('https://nexd.test', 0, 'ECONNREFUSED', true, null))
    await expect(connector.checkConnection(connection(http))).rejects.toThrow(NetworkError)
  })
})
