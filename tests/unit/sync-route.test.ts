import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db.ts'
import { createLimiter } from '../../src/limiter.ts'
import { createLogger } from '../../src/log.ts'
import type { SyncDeps } from '../../src/sync/engine.ts'
import { createRegistry } from '../../src/sync/registry.ts'

const TOKEN = 'a-long-enough-operator-token-0123456789'
const LINK = '00000000-0000-4000-8000-000000000022'
const auth = { authorization: `Bearer ${TOKEN}` }

const config: Config = {
  databaseUrl: 'postgresql://x',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: TOKEN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
}

// Every case here is refused before the handler runs, so the database must never be reached.
const untouchable: Db = {
  query: () => Promise.reject(new Error('database reached')),
  withTransaction: () => Promise.reject(new Error('database reached')),
  withAdvisoryLock: () => Promise.reject(new Error('database reached')),
  stats: () => ({ total: 0, idle: 0, waiting: 0 }),
  close: () => Promise.resolve(),
}

const apps: FastifyInstance[] = []
function build(): FastifyInstance {
  const sync: SyncDeps = {
    db: untouchable,
    registry: createRegistry([]),
    http: { request: () => Promise.reject(new Error('no network')) },
    log: createLogger('silent'),
    limiter: createLimiter(3),
  }
  const app = buildApp({ config, db: untouchable, logger: createLogger('silent'), sync })
  apps.push(app)
  return app
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('sync routes, refused before the handler', () => {
  it.each([
    ['POST', `/sync/links/${LINK}/run`],
    ['GET', `/sync/runs/${LINK}`],
  ] as const)('%s %s needs the operator token', async (method, url) => {
    const res = await build().inject({ method, url })
    expect(res.statusCode).toBe(401)
  })

  it.each<{ name: string; url: string; payload: Record<string, unknown>; message: string }>([
    {
      name: 'a malformed link id',
      url: '/sync/links/not-a-uuid/run',
      payload: {},
      message: 'linkId',
    },
    {
      name: 'from without to',
      url: `/sync/links/${LINK}/run`,
      payload: { from: '2026-09-01' },
      message: 'pass both from and to',
    },
    {
      name: 'an impossible date',
      url: `/sync/links/${LINK}/run`,
      payload: { from: '2026-02-31', to: '2026-03-01' },
      message: 'from',
    },
    {
      name: 'an inverted window',
      url: `/sync/links/${LINK}/run`,
      payload: { from: '2026-09-07', to: '2026-09-01' },
      message: 'to is before from',
    },
    {
      name: 'a window longer than a year',
      url: `/sync/links/${LINK}/run`,
      payload: { from: '2024-01-01', to: '2026-01-01' },
      message: 'at most 366 days',
    },
    {
      name: 'an unknown field',
      url: `/sync/links/${LINK}/run`,
      payload: { dryRun: true, force: true },
      message: 'force',
    },
  ])('rejects $name with 400', async ({ url, payload, message }) => {
    const res = await build().inject({ method: 'POST', url, headers: auth, payload })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain(message)
  })

  it('rejects a malformed run id with 400', async () => {
    const res = await build().inject({ method: 'GET', url: '/sync/runs/42', headers: auth })
    expect(res.statusCode).toBe(400)
  })

  it('accepts a trigger with no body at all', async () => {
    // A body-less POST arrives as null. It must reach the handler — which then fails on this
    // file's deliberately broken database, not on validation.
    const res = await build().inject({
      method: 'POST',
      url: `/sync/links/${LINK}/run`,
      headers: auth,
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal_error' })
  })
})
