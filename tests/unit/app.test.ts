import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Db } from '../../src/db.ts'
import { createLogger } from '../../src/log.ts'

const config = {
  databaseUrl: 'postgresql://x',
  adminToken: 'a-long-enough-operator-token',
  port: 0,
  logLevel: 'silent' as const,
}

function fakeDb(query: Db['query']): Db {
  return {
    query,
    withTransaction: () => Promise.reject(new Error('not used')),
    withAdvisoryLock: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
  }
}

describe('app', () => {
  it('/healthz is always 200', async () => {
    const app = buildApp({
      config,
      db: fakeDb(() => Promise.reject(new Error('down'))),
      logger: createLogger('silent'),
    })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
  })

  it('/readyz is 503 when the database query fails', async () => {
    const app = buildApp({
      config,
      db: fakeDb(() => Promise.reject(new Error('down'))),
      logger: createLogger('silent'),
    })
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'unavailable' })
  })

  it('/readyz is 503 when the database does not answer within 2 s', async () => {
    const never = () => new Promise<never>(() => undefined)
    const app = buildApp({ config, db: fakeDb(never), logger: createLogger('silent') })
    const started = Date.now()
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('/sync and /webhooks require the admin token', async () => {
    const app = buildApp({
      config,
      db: fakeDb(() => Promise.resolve([])),
      logger: createLogger('silent'),
    })
    for (const url of ['/sync/links/x/run', '/webhooks/x/send-now']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(401)
    }
  })
})
