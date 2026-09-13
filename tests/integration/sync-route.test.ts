import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { createDb, type Db } from '../../src/db.ts'
import { createLimiter } from '../../src/limiter.ts'
import { createLogger } from '../../src/log.ts'
import {
  createRunTracker,
  SYNC_MAX_CONNECTIONS,
  type RunTracker,
  type SyncDeps,
} from '../../src/sync/engine.ts'
import { createRegistry } from '../../src/sync/registry.ts'
import type { FetchResult, SourceConnector, SyncContext } from '../../src/sync/types.ts'

// The trigger route and the run status route against real rows, with a scripted connector.
// Fixture ids are unique to this file.
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const TOKEN = 'a-long-enough-operator-token-0123456789'
const auth = { authorization: `Bearer ${TOKEN}` }
const ID = {
  company: '00000000-0000-4000-8000-00000000d001',
  campaign: '00000000-0000-4000-8000-00000000d002',
  credential: '00000000-0000-4000-8000-00000000d011',
  link: '00000000-0000-4000-8000-00000000d021',
} as const
const UNKNOWN = '00000000-0000-4000-8000-0000000000ff'
const THURSDAY = new Date('2026-09-10T02:00:00Z')

const config: Config = {
  databaseUrl: DATABASE_URL,
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: TOKEN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
}

type Script = (ctx: SyncContext) => Promise<FetchResult>

const oneRow: Script = async (ctx) => ({
  rows: [
    {
      date: ctx.window.to,
      language: '',
      campaignTag: '',
      metrics: { impressions: 100 },
      pageViews: [],
      ctaClicks: [],
      unmapped: new Map(),
    },
  ],
  warnings: [],
  covered: ctx.window,
})

describe('sync routes', () => {
  let db: Db
  let app: FastifyInstance
  let tracker: RunTracker
  let script: Script = oneRow

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
    fetchWindow: (ctx) => script(ctx),
  }

  const trigger = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/sync/links/${ID.link}/run`, headers: auth, payload })
  const status = (runId: string) =>
    app.inject({ method: 'GET', url: `/sync/runs/${runId}`, headers: auth })

  async function removeFixtures(): Promise<void> {
    await db.query('DELETE FROM app.campaign WHERE id = $1', [ID.campaign])
    await db.query('DELETE FROM external.credential WHERE id = $1', [ID.credential])
    await db.query('DELETE FROM app.company WHERE id = $1', [ID.company])
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL, { max: 2, ssl: 'disable' })
    await removeFixtures()
    await db.query(`INSERT INTO app.company (id, name) VALUES ($1, 'Route test company')`, [
      ID.company,
    ])
    await db.query(
      `INSERT INTO app.campaign (id, company_id, name, primary_source, starts_on, ends_on)
       VALUES ($1, $2, 'Route test campaign', 'zeus', '2026-08-01', '2026-10-31')`,
      [ID.campaign, ID.company],
    )
    await db.query(
      `INSERT INTO external.credential (id, source_id, name, secret_env_var)
       VALUES ($1, 'zeus', 'route-test-zeus', 'ROUTE_TEST_ZEUS_API_TOKEN')`,
      [ID.credential],
    )
    await db.query(
      `INSERT INTO external.campaign_link (id, campaign_id, source_id, credential_id, language)
       VALUES ($1, $2, 'zeus', $3, 'de')`,
      [ID.link, ID.campaign, ID.credential],
    )
  })

  beforeEach(async () => {
    script = oneRow
    await db.query('DELETE FROM external.sync_run WHERE link_id = $1', [ID.link])
    await db.query('DELETE FROM analytics.advanced_analytics WHERE campaign_id = $1', [ID.campaign])
    tracker = createRunTracker()
    const appDb = createDb(DATABASE_URL, { max: 4, ssl: 'disable' })
    const sync: SyncDeps = {
      db: appDb,
      registry: createRegistry([connector]),
      http: { request: () => Promise.reject(new Error('no network in this test')) },
      log: createLogger('silent'),
      limiter: createLimiter(SYNC_MAX_CONNECTIONS),
      env: { ROUTE_TEST_ZEUS_API_TOKEN: 'scripted' },
      tracker,
      now: () => THURSDAY,
    }
    app = buildApp({ config, db: appDb, logger: createLogger('silent'), tracker, sync })
  })

  // app.close() drains any run still in flight, then closes the app's pool.
  afterEach(async () => {
    await app.close()
  })

  afterAll(async () => {
    await removeFixtures()
    await db.close()
  })

  it('needs the operator token', async () => {
    const res = await app.inject({ method: 'POST', url: `/sync/links/${ID.link}/run`, payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it('answers 202 with the run id, then finishes the run over the lookback in the background', async () => {
    const res = await trigger({})

    expect(res.statusCode).toBe(202)
    const { syncRunId } = res.json<{ syncRunId: string }>()
    expect(await tracker.drain(5_000)).toBe(true)

    const run = await status(syncRunId)
    expect(run.statusCode).toBe(200)
    expect(run.json()).toMatchObject({
      id: syncRunId,
      linkId: ID.link,
      trigger: 'manual',
      dryRun: false,
      status: 'succeeded',
      window: { from: '2026-09-03', to: '2026-09-09' },
      daysWritten: 7,
      rowsWritten: 1,
      error: null,
    })
  })

  it('answers 409 while the link already has a run in progress', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    script = async (ctx) => {
      await gate
      return oneRow(ctx)
    }

    expect((await trigger({})).statusCode).toBe(202)
    const second = await trigger({ from: '2026-09-01', to: '2026-09-02' })

    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: 'run_in_progress' })
    release()
    expect(await tracker.drain(5_000)).toBe(true)
  })

  it('enforces the manual cooldown with 429 and Retry-After', async () => {
    expect((await trigger({})).statusCode).toBe(202)
    expect(await tracker.drain(5_000)).toBe(true)

    const again = await trigger({})

    expect(again.statusCode).toBe(429)
    expect(again.json()).toMatchObject({ error: 'too_soon' })
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('records a dry run over an explicit window without writing rows', async () => {
    const res = await trigger({ from: '2026-09-01', to: '2026-09-02', dryRun: true })

    expect(res.statusCode).toBe(202)
    const { syncRunId } = res.json<{ syncRunId: string }>()
    expect(await tracker.drain(5_000)).toBe(true)
    expect((await status(syncRunId)).json()).toMatchObject({
      dryRun: true,
      status: 'succeeded',
      window: { from: '2026-09-01', to: '2026-09-02' },
    })
    expect(
      await db.query('SELECT 1 FROM analytics.advanced_analytics WHERE campaign_id = $1', [
        ID.campaign,
      ]),
    ).toEqual([])
  })

  it('reports a failed run with its recorded error', async () => {
    script = async () => {
      throw new Error('platform exploded')
    }

    const { syncRunId } = (await trigger({})).json<{ syncRunId: string }>()
    expect(await tracker.drain(5_000)).toBe(true)

    const run = (await status(syncRunId)).json<{ status: string; error: string | null }>()
    expect(run.status).toBe('failed')
    expect(run.error).toContain('platform exploded')
  })

  it('answers 404 for an unknown link and an unknown run', async () => {
    const link = await app.inject({
      method: 'POST',
      url: `/sync/links/${UNKNOWN}/run`,
      headers: auth,
      payload: {},
    })
    expect(link.statusCode).toBe(404)
    expect(link.json()).toMatchObject({ error: 'link_not_found' })

    const run = await status(UNKNOWN)
    expect(run.statusCode).toBe(404)
    expect(run.json()).toMatchObject({ error: 'sync_run_not_found' })
  })
})
