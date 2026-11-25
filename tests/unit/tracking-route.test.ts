import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp, type AppDeps } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import type { Db, Params, Queryable } from '../../src/core/db.ts'
import { createLogger } from '../../src/core/log.ts'
import { charLength } from '../../src/modules/tracking/event.ts'
import { TAG_SCRIPT } from '../../src/modules/tracking/tag.ts'
import type { TrackingDeps } from '../../src/modules/tracking/routes.ts'

// The public page tracker over HTTP, with a scripted database: POST /pages/event counts a visit or
// a conversion with no token, from any site; GET /pages/tag.js serves the script. What the
// database does with a count is tests/integration/page-tracking.test.ts.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const CAMPAIGN = '7f1c9a52-3b9e-4c8e-9a51-2f6b1d0c4e88'
const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const config: Config = {
  databaseUrl: 'postgresql://x',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: ADMIN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
  emailReportSchedulerEnabled: false,
}

interface Call {
  text: string
  params: Params
}

/** What the scripted database answers the upsert: a counted row, or nothing (no such campaign). */
type UpsertAnswer = 'counted' | 'overflow' | 'unknown' | 'fails'

function scriptedDb(answer: () => UpsertAnswer = () => 'counted') {
  const calls: Call[] = []
  const query = (text: string, params: Params = []) => {
    calls.push({ text, params })
    if (text.includes('day_timezone')) return Promise.resolve([{ day_timezone: 'Europe/Zurich' }])
    const outcome = answer()
    if (outcome === 'fails') return Promise.reject(new Error('connection terminated'))
    if (outcome === 'unknown') return Promise.resolve([])
    return Promise.resolve([{ overflow: outcome === 'overflow' }])
  }
  const db = { query } as Queryable
  const upserts = () => calls.filter((call) => !call.text.includes('day_timezone'))
  return { db, calls, upserts }
}

function fullDb(): Db {
  return {
    query: () => Promise.resolve([]),
    withTransaction: () => Promise.reject(new Error('not used')),
    withAdvisoryLock: () => Promise.reject(new Error('not used')),
    stats: () => ({ total: 0, idle: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  }
}

const apps: FastifyInstance[] = []
function build(
  tracking: Partial<TrackingDeps> & Pick<TrackingDeps, 'db'>,
  more: Partial<AppDeps> = {},
) {
  const app = buildApp({
    config,
    db: fullDb(),
    logger: createLogger('silent'),
    tracking: {
      log: createLogger('silent'),
      combinationCap: 2_000,
      ...tracking,
    },
    ...more,
  })
  apps.push(app)
  return app
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const post = (
  app: FastifyInstance,
  body: unknown,
  options: { type?: string; agent?: string; address?: string; raw?: string } = {},
) =>
  app.inject({
    method: 'POST',
    url: '/pages/event',
    headers: {
      'content-type': options.type ?? 'text/plain;charset=UTF-8',
      'user-agent': options.agent ?? BROWSER,
      origin: 'https://shop.example.com',
    },
    remoteAddress: options.address ?? '203.0.113.7',
    payload: options.raw ?? JSON.stringify(body),
  })

describe('POST /pages/event', () => {
  it('counts a visit sent as text/plain, as sendBeacon sends it, with no token', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await post(app, { campaign_id: CAMPAIGN, utm_source: 'Brame' })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(upserts()).toHaveLength(1)
    expect(upserts()[0]?.params).toContain(CAMPAIGN)
    expect(upserts()[0]?.params).toContain('Brame')
  })

  it('reads application/json too', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await post(app, { campaign_id: CAMPAIGN }, { type: 'application/json' })
    expect(res.statusCode).toBe(204)
    expect(upserts()).toHaveLength(1)
  })

  it('counts a conversion as a conversion, never as a visit', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    await post(app, { campaign_id: CAMPAIGN })
    await post(app, { campaign_id: CAMPAIGN, event: 'conversion' })
    const [visit, conversion] = upserts().map((call) => call.params)
    // The two counts are the last parameters before the cap: (visits, conversions, cap).
    expect(visit?.slice(-3)).toEqual([1, 0, 2_000])
    expect(conversion?.slice(-3)).toEqual([0, 1, 2_000])
  })

  it('counts the day in the brame source day zone, not by the server clock (UTC)', async () => {
    const { db, upserts } = scriptedDb()
    let now = new Date('2026-11-24T22:59:59.999Z') // 23:59:59 in Zurich
    const app = build({ db, now: () => now })
    await post(app, { campaign_id: CAMPAIGN })
    now = new Date('2026-11-24T23:00:00.000Z') // midnight in Zurich, still the 24th in UTC
    await post(app, { campaign_id: CAMPAIGN })
    expect(upserts().map((call) => call.params[1])).toEqual(['2026-11-24', '2026-11-25'])
  })

  it('reads the day zone once, not on every post', async () => {
    const { db, calls } = scriptedDb()
    const app = build({ db })
    for (let i = 0; i < 3; i++) await post(app, { campaign_id: CAMPAIGN })
    expect(calls.filter((call) => call.text.includes('day_timezone'))).toHaveLength(1)
  })

  it('answers 404 unknown_campaign when the database has no such campaign (or it is archived)', async () => {
    const { db } = scriptedDb(() => 'unknown')
    const app = build({ db })
    const res = await post(app, { campaign_id: CAMPAIGN })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'unknown_campaign' })
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('answers 204 for a visit counted on the overflow row too', async () => {
    const { db } = scriptedDb(() => 'overflow')
    const app = build({ db })
    expect((await post(app, { campaign_id: CAMPAIGN })).statusCode).toBe(204)
  })

  it.each([
    ['broken JSON', '{"campaign_id":'],
    ['a JSON string', '"hello"'],
    ['nothing', ''],
  ])('refuses %s with 400 invalid_event and writes nothing', async (_name, raw) => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await post(app, undefined, { raw })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid_event' })
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(upserts()).toEqual([])
  })

  it('names the bad fields and echoes no value', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await post(app, { campaign_id: 'DEV0001-not-a-uuid', utm_source: 5 })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'invalid_event',
      message: 'invalid fields: campaign_id, utm_source',
    })
    expect(res.body).not.toContain('DEV0001')
    expect(upserts()).toEqual([])
  })

  it('refuses a body over 8 KB with 413 before reading it', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await post(app, { campaign_id: CAMPAIGN, utm_term: 'x'.repeat(9_000) })
    expect(res.statusCode).toBe(413)
    expect(upserts()).toEqual([])
  })

  it('takes a body just under 8 KB and cuts its long values', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await post(app, { campaign_id: CAMPAIGN, utm_term: 'x'.repeat(7_000) })
    expect(res.statusCode).toBe(204)
    const term = upserts()[0]?.params.find((p) => typeof p === 'string' && p.startsWith('xxx'))
    expect(charLength(term as string)).toBe(255)
  })

  it('refuses a content type a browser does not send for this', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await post(
      app,
      { campaign_id: CAMPAIGN },
      { type: 'application/x-www-form-urlencoded' },
    )
    expect(res.statusCode).toBe(415)
    expect(upserts()).toEqual([])
  })

  it('answers a bot 204 and does not count it', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await post(app, { campaign_id: CAMPAIGN }, { agent: 'Googlebot/2.1' })
    expect(res.statusCode).toBe(204)
    expect(upserts()).toEqual([])
  })

  it('does not limit an address: the edge does, which sees the visitor', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    for (let i = 0; i < 100; i++) {
      expect(
        (await post(app, { campaign_id: CAMPAIGN }, { address: '198.51.100.1' })).statusCode,
      ).toBe(204)
    }
    expect(upserts()).toHaveLength(100)
  })

  it('answers 503 busy over maxInFlight, even for a burst that arrives in one tick', async () => {
    // The database holds every upsert until released, as a full pool would.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: Call[] = []
    const db = {
      query: async (text: string, params: Params = []) => {
        calls.push({ text, params })
        if (text.includes('day_timezone')) return [{ day_timezone: 'Europe/Zurich' }]
        await held
        return [{ overflow: false }]
      },
    } as Queryable
    const app = build({ db, maxInFlight: 3 })
    await app.ready()
    const upserts = () => calls.filter((call) => !call.text.includes('day_timezone'))
    const burst = Array.from({ length: 5 }, () => post(app, { campaign_id: CAMPAIGN }))
    // Wait until three are held by the database (a fixed delay races the boot on a busy machine),
    // and give the other two the time to be answered, before the database answers any.
    for (let turn = 0; turn < 1_000 && upserts().length < 3; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(upserts()).toHaveLength(3)
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    const answers = await Promise.all(burst)
    expect(answers.map((res) => res.statusCode).sort()).toEqual([204, 204, 204, 503, 503])
    const busy = answers.find((res) => res.statusCode === 503)
    expect(busy?.json()).toEqual({ error: 'busy' })
    expect(busy?.headers['retry-after']).toBe('5')
    expect(upserts()).toHaveLength(3)
    // And once they are done, there is room again.
    expect((await post(app, { campaign_id: CAMPAIGN })).statusCode).toBe(204)
  })

  it('frees its place when counting fails', async () => {
    const { db } = scriptedDb(() => 'fails')
    const app = build({ db, maxInFlight: 1 })
    expect((await post(app, { campaign_id: CAMPAIGN })).statusCode).toBe(500)
    expect((await post(app, { campaign_id: CAMPAIGN })).statusCode).toBe(500)
  })

  it('answers a database failure with 500 and no detail, still with the CORS header', async () => {
    const { db } = scriptedDb(() => 'fails')
    const app = build({ db })
    const res = await post(app, { campaign_id: CAMPAIGN })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal_error' })
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('answers the CORS preflight a page sending application/json makes first', async () => {
    const { db, upserts } = scriptedDb()
    const app = build({ db })
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/pages/event',
      headers: {
        origin: 'https://shop.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['access-control-allow-methods']).toBe('POST')
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type')
    expect(res.headers['access-control-max-age']).toBe('86400')
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    expect(upserts()).toEqual([])
  })

  it('logs one summary of outcomes, with counts only', async () => {
    const lines: Record<string, unknown>[] = []
    const destination = new Writable({
      write(chunk: Buffer, _enc, done) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          lines.push(JSON.parse(line) as Record<string, unknown>)
        }
        done()
      },
    })
    const log = createLogger('info', destination)
    const { db } = scriptedDb()
    // The app's own logger too: Fastify's request lines must not carry the visitor's address.
    const app = build({ db, log, summaryEveryMs: 200 }, { logger: log })
    await post(app, { campaign_id: CAMPAIGN, utm_source: 'secret-source-value' })
    await post(app, { campaign_id: CAMPAIGN }, { agent: 'Googlebot' })
    await post(app, undefined, { raw: '{' })
    // Nor do the scope's other answers: a mistyped path in a client's tag reaches the 404.
    await app.inject({ method: 'GET', url: '/pages/tags.js', remoteAddress: '203.0.113.7' })
    await app.inject({ method: 'GET', url: '/pages/tag.js', remoteAddress: '203.0.113.7' })
    await app.inject({ method: 'OPTIONS', url: '/pages/event', remoteAddress: '203.0.113.7' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const summaries = lines.filter((line) => line.msg === 'page events')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ counted: 1, bot: 1, invalid: 1 })
    expect(JSON.stringify(lines)).not.toContain('secret-source-value')
    expect(JSON.stringify(lines)).not.toContain('203.0.113.7')
    expect(lines.filter((line) => line.req !== undefined)).toEqual([])
  })
})

describe('GET /pages/tag.js', () => {
  it('serves the script for any page to load, cached for an hour', async () => {
    const { db } = scriptedDb()
    const app = build({ db })
    const res = await app.inject({ method: 'GET', url: '/pages/tag.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(TAG_SCRIPT)
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.headers['cache-control']).toBe('public, max-age=3600')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('is served with a query string too (a cache-buster)', async () => {
    const { db } = scriptedDb()
    const app = build({ db })
    expect((await app.inject({ method: 'GET', url: '/pages/tag.js?v=2' })).statusCode).toBe(200)
  })
})

describe('the /pages scope', () => {
  it('answers 404 for everything else, with or without the admin token', async () => {
    const { db } = scriptedDb()
    const app = build({ db })
    for (const [method, url] of [
      ['GET', '/pages/event'],
      ['GET', '/pages/'],
      ['POST', '/pages/tag.js'],
      ['DELETE', '/pages/event'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${ADMIN}` } })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
  })

  it('does not exist without its dependencies', async () => {
    const app = buildApp({ config, db: fullDb(), logger: createLogger('silent') })
    apps.push(app)
    expect((await post(app, { campaign_id: CAMPAIGN })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/pages/tag.js' })).statusCode).toBe(404)
  })

  it('opens no admin route: the admin scopes still want their token', async () => {
    const { db } = scriptedDb()
    const app = build({ db })
    const res = await app.inject({ method: 'GET', url: '/campaigns' })
    expect(res.statusCode).toBe(401)
  })
})
