import { Client, type QueryResultRow } from 'pg'
import { dateAsStringTypes } from '../../src/db.ts'
import { afterEach, beforeEach } from 'vitest'

// One client per test file, every test inside its own transaction that is rolled back,
// so tests never leak rows into the seeded local database.
export function useTransactionalClient(): { sql: typeof sql } {
  let client: Client

  beforeEach(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL, types: dateAsStringTypes })
    await client.connect()
    await client.query('BEGIN')
  })

  afterEach(async () => {
    await client.query('ROLLBACK')
    await client.end()
  })

  // Each statement runs inside a savepoint so an expected failure does not poison the
  // surrounding transaction (Postgres would otherwise answer 25P02 to everything after it).
  async function sql<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await client.query('SAVEPOINT stmt')
    try {
      const result = await client.query<T>(text, params)
      await client.query('RELEASE SAVEPOINT stmt')
      return result.rows
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT stmt')
      throw error
    }
  }

  return { sql }
}

export const SEED = {
  companyId: '00000000-0000-4000-8000-000000000001',
  campaignId: '00000000-0000-4000-8000-000000000002',
  nexdLinkId: '00000000-0000-4000-8000-000000000021',
  zeusLinkId: '00000000-0000-4000-8000-000000000022',
} as const

/** Runs a statement expected to fail and returns the Postgres SQLSTATE code. */
export async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}
