import pg, { type QueryResultRow } from 'pg'

export type Params = readonly unknown[]

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: Params): Promise<T[]>
}

/** A client inside an open transaction. */
export interface Tx extends Queryable {
  /** Transaction-scoped advisory lock on a text key (released at COMMIT/ROLLBACK). */
  xactLock(key: string): Promise<void>
}

export interface Db extends Queryable {
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  /**
   * Session-level try-lock for leader election: runs `fn` only if the lock was free,
   * holding a dedicated connection for the duration. Returns `{ acquired: false }` otherwise.
   */
  withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<{ acquired: boolean; result?: T }>
  close(): Promise<void>
}

export interface DbOptions {
  /** RFC-002 §6.1: 10 per instance; 4 instances stay under the Supavisor ceiling. */
  max?: number
}

export function createDb(connectionString: string, options: DbOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })

  async function query<T extends QueryResultRow>(text: string, params: Params = []): Promise<T[]> {
    const result = await pool.query<T>(text, params as unknown[])
    return result.rows
  }

  async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    const tx: Tx = {
      async query<T extends QueryResultRow>(text: string, params: Params = []) {
        const result = await client.query<T>(text, params as unknown[])
        return result.rows
      },
      async xactLock(key: string) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
      },
    }
    try {
      await client.query('BEGIN')
      const result = await fn(tx)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async function withAdvisoryLock<T>(
    key: number,
    fn: () => Promise<T>,
  ): Promise<{ acquired: boolean; result?: T }> {
    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [key],
      )
      if (!rows[0]?.locked) return { acquired: false }
      try {
        return { acquired: true, result: await fn() }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [key])
      }
    } finally {
      client.release()
    }
  }

  return { query, withTransaction, withAdvisoryLock, close: () => pool.end() }
}
