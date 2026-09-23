import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { createDb, type DbOptions } from '../../src/db.ts'
import { createLogger } from '../../src/log.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? ''

const config: Config = {
  databaseUrl: DATABASE_URL,
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: 'a-long-enough-operator-token-0123456789',
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
}

const localDb = (options: DbOptions = {}) => createDb(DATABASE_URL, { ssl: 'disable', ...options })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe('/readyz against local Postgres', () => {
  it('returns 200 when SELECT 1 succeeds; app.close() also closes the pool', async () => {
    const app = buildApp({ config, db: localDb({ max: 2 }), logger: createLogger('silent') })
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'ok' })
    } finally {
      await app.close()
    }
  })

  it('returns 503 when Postgres is unreachable', async () => {
    const db = createDb('postgresql://postgres:postgres@127.0.0.1:1/postgres', {
      max: 1,
      ssl: 'disable',
    })
    const app = buildApp({ config, db, logger: createLogger('silent') })
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })
})

describe('db helpers', () => {
  it('withTransaction commits, rolls back on error, and xactLock works inside', async () => {
    const db = localDb({ max: 2 })
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

  it('returns DATE columns as YYYY-MM-DD strings and timestamps as Dates', async () => {
    const db = localDb({ max: 1 })
    try {
      const [row] = await db.query<{ d: unknown; t: unknown }>(
        `SELECT DATE '2026-09-01' AS d, now() AS t`,
      )
      expect(row?.d).toBe('2026-09-01')
      expect(row?.t).toBeInstanceOf(Date)
    } finally {
      await db.close()
    }
  })

  it('applies statement, lock and idle-in-transaction timeouts and an application_name', async () => {
    const db = localDb({ max: 1 })
    try {
      const [row] = await db.query<Record<string, string>>(
        `SELECT current_setting('statement_timeout') AS statement_timeout,
                current_setting('lock_timeout') AS lock_timeout,
                current_setting('idle_in_transaction_session_timeout') AS idle,
                current_setting('application_name') AS app`,
      )
      expect(row).toEqual({
        statement_timeout: '2min',
        lock_timeout: '10s',
        idle: '1min',
        app: 'analytics-be',
      })
    } finally {
      await db.close()
    }
  })

  it('sets the timeouts as session settings, which a session pooler passes through', async () => {
    // Startup parameters show up as source 'client', and a pooler may drop them on the way; a
    // setting made by a statement on the connection shows up as 'session'.
    const db = localDb({ max: 1 })
    try {
      const rows = await db.query<{ name: string; source: string }>(
        `SELECT name, source FROM pg_settings
          WHERE name IN ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout')
          ORDER BY name`,
      )
      expect(rows).toEqual([
        { name: 'idle_in_transaction_session_timeout', source: 'session' },
        { name: 'lock_timeout', source: 'session' },
        { name: 'statement_timeout', source: 'session' },
      ])
    } finally {
      await db.close()
    }
  })

  it('survives an idle connection being terminated by the server instead of crashing the process', async () => {
    const lines: string[] = []
    const logger = createLogger('error', { write: (line: string) => void lines.push(line) })
    const db = localDb({ max: 2, logger, applicationName: 'analytics-be-terminate-test' })
    try {
      await db.query('SELECT 1') // leaves an idle client in the pool
      await withAdminClient((admin) =>
        admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'analytics-be-terminate-test'`,
        ),
      )
      await sleep(200)
      expect(lines.join('')).toContain('idle postgres client error')
      await expect(db.query('SELECT 1')).resolves.toHaveLength(1)
    } finally {
      await db.close()
    }
  })

  it('destroys a connection whose ROLLBACK failed instead of returning it to the pool', async () => {
    const logger = createLogger('silent')
    const db = localDb({ max: 1, logger, applicationName: 'analytics-be-rollback-test' })
    try {
      await expect(
        db.withTransaction(async (tx) => {
          const [me] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          await withAdminClient((admin) =>
            admin.query('SELECT pg_terminate_backend($1)', [me?.pid]),
          )
          await sleep(100)
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      // With max 1, a dead connection returned to the pool would fail this query.
      await expect(db.query('SELECT 1 AS ok')).resolves.toEqual([{ ok: 1 }])
    } finally {
      await db.close()
    }
  })

  it('reports pool stats', async () => {
    const db = localDb({ max: 2 })
    try {
      await db.query('SELECT 1')
      expect(db.stats()).toMatchObject({ total: 1, idle: 1, waiting: 0 })
    } finally {
      await db.close()
    }
  })

  it('withAdvisoryLock runs one holder at a time and the holder can verify it still holds the lock', async () => {
    const db = localDb({ max: 3 })
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const first = db.withAdvisoryLock(4242, async (lease) => {
        await lease.assertHeld()
        await gate
        return 'first'
      })
      await sleep(50)
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

  it('leader locks and single-key link locks live in separate keyspaces', async () => {
    const db = localDb({ max: 3 })
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      let locked!: () => void
      const holding = new Promise<void>((resolve) => (locked = resolve))
      // Hold the SINGLE-bigint lock whose value equals the leader key...
      const tx = db.withTransaction(async (t) => {
        await t.query('SELECT pg_advisory_xact_lock($1::bigint)', [4243])
        locked()
        await gate
      })
      await holding
      // ...and the two-integer leader lock with the same key is still free.
      const leader = await db.withAdvisoryLock(4243, () => Promise.resolve('leader'))
      expect(leader).toEqual({ acquired: true, result: 'leader' })
      release()
      await tx
    } finally {
      await db.close()
    }
  })

  it('rejects a leader key outside int4', async () => {
    const db = localDb({ max: 1 })
    try {
      await expect(db.withAdvisoryLock(-1, () => Promise.resolve(1))).rejects.toThrow(RangeError)
    } finally {
      await db.close()
    }
  })
})
