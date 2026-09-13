import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildApp, type AppDeps } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db.ts'
import { HttpError } from '../../src/http/HttpClient.ts'
import { createLogger } from '../../src/log.ts'
import { createRunTracker } from '../../src/sync/engine.ts'
import { InvalidLinkConfigError, TooSoonError } from '../../src/sync/errors.ts'

const TOKEN = 'a-long-enough-operator-token-0123456789'

const config: Config = {
  databaseUrl: 'postgresql://x',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: TOKEN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
}

function fakeDb(query: Db['query'] = () => Promise.resolve([])): Db {
  return {
    query,
    withTransaction: () => Promise.reject(new Error('not used')),
    withAdvisoryLock: () => Promise.reject(new Error('not used')),
    stats: () => ({ total: 1, idle: 0, waiting: 2 }),
    close: () => Promise.resolve(),
  }
}

const apps: FastifyInstance[] = []
function build(overrides: Partial<AppDeps> = {}): FastifyInstance {
  const app = buildApp({ config, db: fakeDb(), logger: createLogger('silent'), ...overrides })
  apps.push(app)
  return app
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('app', () => {
  it('/healthz is always 200', async () => {
    const app = build({ db: fakeDb(() => Promise.reject(new Error('down'))) })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
  })

  it('/readyz is 503 when the database query fails', async () => {
    const app = build({ db: fakeDb(() => Promise.reject(new Error('down'))) })
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'unavailable' })
  })

  it('/readyz is 503 when the database does not answer within 2 s', async () => {
    const never = () => new Promise<never>(() => undefined)
    const app = build({ db: fakeDb(never) })
    const started = Date.now()
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('/sync and /webhooks authenticate every method and unknown path before answering', async () => {
    const app = build()
    const cases: ['GET' | 'POST' | 'DELETE', string][] = [
      ['GET', '/sync/links/x/run'],
      ['POST', '/sync/links/x/run'],
      ['DELETE', '/sync/anything/at/all'],
      ['POST', '/webhooks/x/send-now'],
      ['GET', '/webhooks/nope'],
    ]
    for (const [method, url] of cases) {
      const res = await app.inject({ method, url })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
      expect(res.headers['cache-control']).toBe('no-store')
    }
    for (const [method, url] of cases) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` } })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
      expect(res.json()).toEqual({ error: 'not_found' })
    }
  })

  it('answers unknown public paths with a plain 404', async () => {
    const res = await build().inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found' })
  })

  it('maps typed errors to statuses and never echoes internal messages', async () => {
    const app = build()
    app.get('/too-soon', async () => {
      throw new TooSoonError('last run was 10 s ago; wait 290 s', 290)
    })
    app.get('/bad-config', async () => {
      throw new InvalidLinkConfigError('invalid', [
        { path: 'clickthrough_cta_id', message: 'Required' },
      ])
    })
    app.get('/upstream', async () => {
      throw new HttpError(503, 'https://zeus.test/x?token=secret-token', 'Bearer leaked-bearer')
    })
    app.get('/internal', async () => {
      throw new Error('connect to postgresql://u:hunter2@db failed; set DATABASE_URL')
    })

    const tooSoon = await app.inject({ method: 'GET', url: '/too-soon' })
    expect(tooSoon.statusCode).toBe(429)
    expect(tooSoon.headers['retry-after']).toBe('290')
    expect(tooSoon.json()).toEqual({
      error: 'too_soon',
      message: 'last run was 10 s ago; wait 290 s',
    })

    const badConfig = await app.inject({ method: 'GET', url: '/bad-config' })
    expect(badConfig.statusCode).toBe(422)
    expect(badConfig.json()).toEqual({
      error: 'invalid_link_config',
      issues: [{ path: 'clickthrough_cta_id', message: 'Required' }],
    })

    const upstream = await app.inject({ method: 'GET', url: '/upstream' })
    expect(upstream.statusCode).toBe(502)
    expect(upstream.json()).toEqual({ error: 'upstream_http' })

    const internal = await app.inject({ method: 'GET', url: '/internal' })
    expect(internal.statusCode).toBe(500)
    expect(internal.json()).toEqual({ error: 'internal_error' })
    for (const res of [upstream, internal]) {
      expect(res.body).not.toMatch(/hunter2|DATABASE_URL|secret-token|leaked-bearer/)
    }
  })

  it('validates route bodies with zod schemas', async () => {
    const app = build()
    app.post(
      '/echo',
      { schema: { body: z.object({ n: z.number().int() }) } },
      async (request) => request.body,
    )
    const ok = await app.inject({ method: 'POST', url: '/echo', payload: { n: 3 } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ n: 3 })
    const bad = await app.inject({ method: 'POST', url: '/echo', payload: { n: 'three' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ error: 'FST_ERR_VALIDATION' })
  })

  it('rejects bodies over the 64 KB limit', async () => {
    const app = build()
    app.post('/echo', async () => ({ ok: true }))
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { blob: 'x'.repeat(70_000) },
    })
    expect(res.statusCode).toBe(413)
  })

  it('gives every request a UUID id', async () => {
    const app = build()
    app.get('/id', async (request) => ({ id: request.id }))
    const res = await app.inject({ method: 'GET', url: '/id' })
    expect(res.json<{ id: string }>().id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('trusts X-Forwarded-For only for the configured number of proxy hops', async () => {
    const direct = build()
    direct.get('/ip', async (request) => ({ ip: request.ip }))
    const behindProxy = build({ config: { ...config, trustProxyHops: 1 } })
    behindProxy.get('/ip', async (request) => ({ ip: request.ip }))
    const headers = { 'x-forwarded-for': '203.0.113.9' }
    expect((await direct.inject({ method: 'GET', url: '/ip', headers })).json()).toEqual({
      ip: '127.0.0.1',
    })
    expect((await behindProxy.inject({ method: 'GET', url: '/ip', headers })).json()).toEqual({
      ip: '203.0.113.9',
    })
  })

  it('close() drains in-flight runs first, then closes the database pool once', async () => {
    const close = vi.fn(() => Promise.resolve())
    const db: Db = { ...fakeDb(), close }
    const tracker = createRunTracker()
    const app = buildApp({ config, db, logger: createLogger('silent'), tracker })
    let finished = false
    void tracker.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          finished = true
          resolve()
        }, 30),
      ),
    )
    await app.close()
    expect(finished).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
