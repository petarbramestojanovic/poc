import pg, { type PoolClient, type QueryResultRow } from 'pg'
import type { Limiter } from './limiter.ts'
import { createLogger, type Logger } from './log.ts'

export type Params = readonly unknown[]

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: Params): Promise<T[]>
}

/** A client inside an open transaction. */
export interface Tx extends Queryable {
  /** Transaction-scoped advisory lock on a text key (released at COMMIT/ROLLBACK). */
  xactLock(key: string): Promise<void>
}

export interface LeaderLease {
  /** Re-checks, on the lock's own connection, that the lock is still held. Call before irreversible work. */
  assertHeld(): Promise<void>
}

export interface PoolStats {
  total: number
  idle: number
  waiting: number
}

export interface Db extends Queryable {
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  /**
   * Session-level try-lock for leader election: runs `fn` only if the lock was free, holding a
   * dedicated connection for the duration. Returns `{ acquired: false }` otherwise.
   *
   * Requires a real session: a direct connection or Supavisor's SESSION pooler. Under the
   * transaction pooler (port 6543, rejected by config) consecutive statements can land on
   * different backends and the lock silently stops meaning anything.
   *
   * Uses the two-integer advisory keyspace under LEADER_LOCK_NAMESPACE, which cannot collide
   * with the single-bigint `hashtext(link_id)` locks the day writer takes.
   */
  withAdvisoryLock<T>(
    key: number,
    fn: (lease: LeaderLease) => Promise<T>,
  ): Promise<{ acquired: boolean; result?: T }>
  stats(): PoolStats
  close(): Promise<void>
}

export interface DbOptions {
  /** RFC-002 §6.1: 10 per instance; 4 instances stay under the Supavisor ceiling. */
  max?: number
  logger?: Logger
  /** verify-full verifies the server certificate; disable is for loopback development only. */
  ssl?: 'disable' | 'verify-full'
  sslCa?: string | undefined
  applicationName?: string
  statementTimeoutMs?: number
  lockTimeoutMs?: number
  idleInTransactionTimeoutMs?: number
  maxLifetimeSeconds?: number
}

/** Namespace (first int) of the two-integer advisory keyspace used for leader locks. */
export const LEADER_LOCK_NAMESPACE = 0x6162 // "ab"

const DEFAULTS = {
  max: 10,
  applicationName: 'analytics-be',
  statementTimeoutMs: 120_000,
  lockTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 60_000,
  maxLifetimeSeconds: 30 * 60,
} as const

/** SQLSTATE classes that mean the connection itself is unusable and must not return to the pool. */
function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string')
    return error instanceof Error && /connection|terminat/i.test(error.message)
  return code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03'
}

/** DATE columns come back as 'YYYY-MM-DD' strings — the service's IsoDate — never as JS Dates. */
const DATE_OID = 1082 // pg.types.builtins.DATE

type TextParser = (value: string) => unknown

/** Exported so integration tests read dates exactly as the service does. */
export const dateAsStringTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number): TextParser =>
    oid === DATE_OID
      ? (value: string) => value
      : (pg.types.getTypeParser(
          oid,
          'text',
        ) as TextParser)) as pg.CustomTypesConfig['getTypeParser'],
}

/** SSL parameters in the URL would override the explicit `ssl` option in node-postgres. */
function stripSslParams(connectionString: string): string {
  const url = new URL(connectionString)
  for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
    url.searchParams.delete(key)
  }
  return url.toString()
}

export function createDb(connectionString: string, options: DbOptions = {}): Db {
  const logger = options.logger ?? createLogger('error')
  const sslMode = options.ssl ?? 'verify-full'

  const pool = new pg.Pool({
    connectionString: stripSslParams(connectionString),
    ssl:
      sslMode === 'disable'
        ? false
        : { rejectUnauthorized: true, ...(options.sslCa ? { ca: options.sslCa } : {}) },
    max: options.max ?? DEFAULTS.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    maxLifetimeSeconds: options.maxLifetimeSeconds ?? DEFAULTS.maxLifetimeSeconds,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: options.applicationName ?? DEFAULTS.applicationName,
    statement_timeout: options.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs,
    lock_timeout: options.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs,
    idle_in_transaction_session_timeout:
      options.idleInTransactionTimeoutMs ?? DEFAULTS.idleInTransactionTimeoutMs,
    types: dateAsStringTypes,
  })

  // node-postgres emits 'error' on IDLE clients when a backend is terminated or the network
  // drops — routine against a managed database. An unhandled 'error' event throws and would
  // take the whole process down, so this listener is not optional.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle postgres client error')
  })

  /** Checked-out clients get their own listener; the pool only watches idle ones. */
  async function checkout(): Promise<{ client: PoolClient; done: (error?: unknown) => void }> {
    const client = await pool.connect()
    const onError = (err: Error) => {
      logger.error({ err }, 'postgres client error while checked out')
    }
    client.on('error', onError)
    return {
      client,
      done(error?: unknown) {
        client.off('error', onError)
        client.release(
          error !== undefined && isConnectionFailure(error) ? toError(error) : undefined,
        )
      },
    }
  }

  async function query<T extends QueryResultRow>(text: string, params: Params = []): Promise<T[]> {
    const result = await pool.query<T>(text, params as unknown[])
    return result.rows
  }

  async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const { client, done } = await checkout()
    const tx: Tx = {
      async query<R extends QueryResultRow>(text: string, params: Params = []) {
        const result = await client.query<R>(text, params as unknown[])
        return result.rows
      },
      async xactLock(key: string) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
      },
    }
    let releaseError: unknown
    try {
      await client.query('BEGIN')
      const result = await fn(tx)
      await client.query('COMMIT')
      return result
    } catch (error) {
      releaseError = error
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        // A failed ROLLBACK means the connection is broken: destroy it, never re-pool it.
        logger.error({ err: rollbackError }, 'ROLLBACK failed; discarding connection')
        releaseError = rollbackError instanceof Error ? markBroken(rollbackError) : rollbackError
      }
      throw error
    } finally {
      done(releaseError)
    }
  }

  async function withAdvisoryLock<T>(
    key: number,
    fn: (lease: LeaderLease) => Promise<T>,
  ): Promise<{ acquired: boolean; result?: T }> {
    if (!Number.isInteger(key) || key < 0 || key > 2_147_483_647) {
      throw new RangeError('leader lock key must be a non-negative int4')
    }
    const { client, done } = await checkout()
    let releaseError: unknown
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
        [LEADER_LOCK_NAMESPACE, key],
      )
      if (!rows[0]?.locked) return { acquired: false }
      const lease: LeaderLease = {
        async assertHeld() {
          const held = await client.query<{ held: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_locks
                WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
                  AND classid = $1::int::oid AND objid = $2::int::oid AND objsubid = 2
             ) AS held`,
            [LEADER_LOCK_NAMESPACE, key],
          )
          if (!held.rows[0]?.held) throw new Error(`leader lock ${key} is no longer held`)
        },
      }
      try {
        return { acquired: true, result: await fn(lease) }
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [
            LEADER_LOCK_NAMESPACE,
            key,
          ])
        } catch (unlockError) {
          // Destroying the session releases every session lock it held.
          logger.error({ err: unlockError }, 'advisory unlock failed; discarding connection')
          releaseError = unlockError instanceof Error ? markBroken(unlockError) : unlockError
        }
      }
    } catch (error) {
      releaseError ??= error
      throw error
    } finally {
      done(releaseError)
    }
  }

  return {
    query,
    withTransaction,
    withAdvisoryLock,
    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    close: () => pool.end(),
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Tags an error so `done()` destroys the connection regardless of its SQLSTATE. */
function markBroken(error: Error): Error {
  return Object.assign(error, { code: (error as { code?: string }).code ?? '08000' })
}

/**
 * The same Db, with every query and transaction taken through `limiter`. The leader lock is
 * not limited: it is held for a whole scheduler pass while the limited work runs inside it.
 */
export function limitDb(db: Db, limiter: Limiter): Db {
  return {
    query: (text, params) => limiter.run(() => db.query(text, params)),
    withTransaction: (fn) => limiter.run(() => db.withTransaction(fn)),
    withAdvisoryLock: (key, fn) => db.withAdvisoryLock(key, fn),
    stats: () => db.stats(),
    close: () => db.close(),
  }
}
