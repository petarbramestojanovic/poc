import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDb, type Db } from '../../src/db.ts'
import { createLimiter } from '../../src/limiter.ts'
import { createLogger } from '../../src/log.ts'
import { SYNC_MAX_CONNECTIONS, type SyncDeps } from '../../src/sync/engine.ts'
import { runNightlyTick } from '../../src/sync/nightly.ts'
import { createRegistry } from '../../src/sync/registry.ts'
import type { SourceConnector } from '../../src/sync/types.ts'

// Two replicas, each with its own pool and so its own Postgres sessions, tick at the same moment.
// The leader lock must let exactly one of them run the pass. Fixture ids are unique to this file.
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const ID = {
  company: '00000000-0000-4000-8000-00000000c001',
  campaign: '00000000-0000-4000-8000-00000000c002',
  credential: '00000000-0000-4000-8000-00000000c011',
  linkDe: '00000000-0000-4000-8000-00000000c021',
  linkFr: '00000000-0000-4000-8000-00000000c022',
} as const
const LINKS = [ID.linkDe, ID.linkFr] as const
const THURSDAY = new Date('2026-09-10T02:00:00Z') // 04:00 in Zurich

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('nightly ticks across replicas', () => {
  let replicaA: Db
  let replicaB: Db
  let fetches = 0

  const connector: SourceConnector = {
    id: 'zeus',
    capabilities: {
      granularity: 'daily',
      restatementWindowDays: 7,
      maxWindowDays: 31,
      verifiesAgainstTotals: false,
    },
    identity: { levels: ['creative'], multiple: true },
    describe: () => ({ configSchema: z.looseObject({}) }),
    checkConnection: async () => ({ ok: true, message: 'scripted' }),
    fetchWindow: async (ctx) => {
      fetches++
      await sleep(150) // long enough that the second replica ticks while the first holds the lock
      return { rows: [], warnings: [], covered: ctx.window }
    },
  }

  const deps = (db: Db): SyncDeps => ({
    db,
    registry: createRegistry([connector]),
    http: { request: () => Promise.reject(new Error('no network in this test')) },
    log: createLogger('silent'),
    limiter: createLimiter(SYNC_MAX_CONNECTIONS),
    env: { TICK_TEST_ZEUS_API_TOKEN: 'scripted' },
    now: () => THURSDAY,
  })

  async function removeFixtures(): Promise<void> {
    await replicaA.query('DELETE FROM app.campaign WHERE id = $1', [ID.campaign])
    await replicaA.query('DELETE FROM external.credential WHERE id = $1', [ID.credential])
    await replicaA.query('DELETE FROM app.company WHERE id = $1', [ID.company])
  }

  beforeAll(async () => {
    replicaA = createDb(DATABASE_URL, { max: 4, ssl: 'disable' })
    replicaB = createDb(DATABASE_URL, { max: 4, ssl: 'disable' })
    await removeFixtures()
    await replicaA.query(`INSERT INTO app.company (id, name) VALUES ($1, 'Tick test company')`, [
      ID.company,
    ])
    await replicaA.query(
      `INSERT INTO app.campaign (id, company_id, name, primary_source, starts_on, ends_on)
       VALUES ($1, $2, 'Tick test campaign', 'zeus', '2026-08-01', '2026-10-31')`,
      [ID.campaign, ID.company],
    )
    await replicaA.query(
      `INSERT INTO external.credential (id, source_id, name, secret_env_var)
       VALUES ($1, 'zeus', 'tick-test-zeus', 'TICK_TEST_ZEUS_API_TOKEN')`,
      [ID.credential],
    )
    await replicaA.query(
      `INSERT INTO external.campaign_link (id, campaign_id, source_id, credential_id, language) VALUES
         ($1, $3, 'zeus', $4, 'de'),
         ($2, $3, 'zeus', $4, 'fr')`,
      [ID.linkDe, ID.linkFr, ID.campaign, ID.credential],
    )
  })

  beforeEach(async () => {
    fetches = 0
    await replicaA.query('DELETE FROM external.sync_run WHERE link_id = ANY($1::uuid[])', [LINKS])
  })

  afterAll(async () => {
    await removeFixtures()
    await replicaA.close()
    await replicaB.close()
  })

  it('runs the pass once when two replicas tick together', async () => {
    const [a, b] = await Promise.all([
      runNightlyTick(deps(replicaA), { onlyLinkIds: LINKS }),
      runNightlyTick(deps(replicaB), { onlyLinkIds: LINKS }),
    ])

    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1)
    const winner = a.acquired ? a : b
    expect(winner.pass?.results.map((r) => r.outcome.status)).toEqual(['succeeded', 'succeeded'])
    expect(fetches).toBe(2)
    const runs = await replicaA.query(
      'SELECT 1 FROM external.sync_run WHERE link_id = ANY($1::uuid[])',
      [LINKS],
    )
    expect(runs).toHaveLength(2)
  })

  it('releases the lock when the pass ends, so the next tick runs', async () => {
    const first = await runNightlyTick(deps(replicaA), { onlyLinkIds: LINKS })
    const second = await runNightlyTick(deps(replicaB), { onlyLinkIds: LINKS })

    expect(first.acquired).toBe(true)
    expect(second.acquired).toBe(true)
    expect(fetches).toBe(4)
  })
})
