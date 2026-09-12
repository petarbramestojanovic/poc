import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { createDb } from '../../src/db.ts'
import { createLogger } from '../../src/log.ts'

const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  adminToken: 'a-long-enough-operator-token',
  port: 0,
  logLevel: 'silent' as const,
}

describe('/readyz against local Postgres', () => {
  it('returns 200 when SELECT 1 succeeds', async () => {
    const db = createDb(config.databaseUrl, { max: 2 })
    const app = buildApp({ config, db, logger: createLogger('silent') })
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'ok' })
    } finally {
      await app.close()
      await db.close()
    }
  })

  it('returns 503 when Postgres is unreachable', async () => {
    const db = createDb('postgresql://postgres:postgres@127.0.0.1:1/postgres', { max: 1 })
    const app = buildApp({ config, db, logger: createLogger('silent') })
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
      await db.close()
    }
  })
})

describe('db helpers', () => {
  it('withTransaction commits, rolls back on error, and xactLock works inside', async () => {
    const db = createDb(config.databaseUrl, { max: 2 })
    try {
      await expect(
        db.withTransaction(async (tx) => {
          await tx.xactLock('link:test')
          await tx.query('SELECT 1')
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      const rows = await db.withTransaction((tx) => tx.query<{ n: number }>('SELECT 1 AS n'))
      expect(rows).toEqual([{ n: 1 }])
    } finally {
      await db.close()
    }
  })

  it('withAdvisoryLock runs one holder at a time', async () => {
    const db = createDb(config.databaseUrl, { max: 3 })
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const first = db.withAdvisoryLock(4242, async () => {
        await gate
        return 'first'
      })
      await new Promise((r) => setTimeout(r, 50))
      const second = await db.withAdvisoryLock(4242, () => Promise.resolve('second'))
      expect(second).toEqual({ acquired: false })
      release()
      expect(await first).toEqual({ acquired: true, result: 'first' })
      const third = await db.withAdvisoryLock(4242, () => Promise.resolve('third'))
      expect(third).toEqual({ acquired: true, result: 'third' })
    } finally {
      await db.close()
    }
  })
})
