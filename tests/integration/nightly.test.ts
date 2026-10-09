import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDb, type Db, type LeaderLease } from '../../src/core/db.ts'
import type { HttpClient } from '../../src/core/http/HttpClient.ts'
import { createLimiter } from '../../src/core/limiter.ts'
import { createLogger } from '../../src/core/log.ts'
import { SYNC_MAX_CONNECTIONS, type SyncDeps } from '../../src/modules/sync/engine.ts'
import { runNightlyPass, type LinkResult } from '../../src/modules/sync/nightly.ts'
import { createRegistry } from '../../src/modules/sync/registry.ts'
import type { FetchResult, SourceConnector, SyncContext } from '../../src/modules/sync/types.ts'

// The nightly pass against real rows, with scripted connectors standing in for the platforms.
// Every row this file writes uses ids no other test file writes, and every pass is restricted to
// these links, so links you created locally are never synced by a test.
const ID = {
  company: '00000000-0000-4000-8000-00000000b001',
  campaign: '00000000-0000-4000-8000-00000000b002',
  nexdCredential: '00000000-0000-4000-8000-00000000b011',
  zeusCredential: '00000000-0000-4000-8000-00000000b012',
  nexdLink: '00000000-0000-4000-8000-00000000b021',
  zeusLinkDe: '00000000-0000-4000-8000-00000000b022',
  zeusLinkFr: '00000000-0000-4000-8000-00000000b023',
} as const
const OUR_LINKS = [ID.nexdLink, ID.zeusLinkDe, ID.zeusLinkFr] as const

const THURSDAY = new Date('2026-09-10T02:00:00Z') // 04:00 in Zurich
const SUNDAY = new Date('2026-09-13T02:00:00Z') // 04:00 in Zurich

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Script = (ctx: SyncContext) => Promise<FetchResult>

describe('nightly pass', () => {
  let db: Db
  let script: Script
  let active = 0
  let maxActive = 0
  let maxPerCredential = 0
  const perCredential = new Map<string, number>()

  // Records how many fetches overlap overall and per credential, then returns one row.
  const tracked: Script = async (ctx) => {
    active++
    maxActive = Math.max(maxActive, active)
    const mine = (perCredential.get(ctx.credential.id) ?? 0) + 1
    perCredential.set(ctx.credential.id, mine)
    maxPerCredential = Math.max(maxPerCredential, mine)
    try {
      await sleep(40)
      return {
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
      }
    } finally {
      active--
      perCredential.set(ctx.credential.id, (perCredential.get(ctx.credential.id) ?? 1) - 1)
    }
  }

  const connector = (id: string): SourceConnector => ({
    id,
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
  })
  const http: HttpClient = { request: () => Promise.reject(new Error('no network in this test')) }

  const pass = (now: Date, lease?: LeaderLease) => {
    const deps: SyncDeps = {
      db,
      registry: createRegistry([connector('nexd'), connector('zeus')]),
      http,
      log: createLogger('silent'),
      limiter: createLimiter(SYNC_MAX_CONNECTIONS),
      env: { NIGHTLY_NEXD_API_KEY: 'scripted', NIGHTLY_ZEUS_API_TOKEN: 'scripted' },
      now: () => now,
    }
    return runNightlyPass(deps, { onlyLinkIds: OUR_LINKS, ...(lease ? { lease } : {}) })
  }
  const statusByLink = (results: LinkResult[]) =>
    Object.fromEntries(results.map((r) => [r.linkId, r.outcome.status]))

  async function removeFixtures(): Promise<void> {
    // Links, runs, state and rollups cascade from the campaign.
    await db.query('DELETE FROM app.campaign WHERE id = $1', [ID.campaign])
    await db.query('DELETE FROM external.credential WHERE id = ANY($1::uuid[])', [
      [ID.nexdCredential, ID.zeusCredential],
    ])
    await db.query('DELETE FROM app.company WHERE id = $1', [ID.company])
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 6, ssl: 'disable' })
    await removeFixtures()
    await db.query(`INSERT INTO app.company (id, name) VALUES ($1, 'Nightly test company')`, [
      ID.company,
    ])
    await db.query(
      `INSERT INTO app.campaign (id, company_id, name, primary_source)
       VALUES ($1, $2, 'Nightly test campaign', 'zeus')`,
      [ID.campaign, ID.company],
    )
    await db.query(
      `INSERT INTO external.credential (id, source_id, name, secret_env_var) VALUES
         ($1, 'nexd', 'nightly-test-nexd', 'NIGHTLY_NEXD_API_KEY'),
         ($2, 'zeus', 'nightly-test-zeus', 'NIGHTLY_ZEUS_API_TOKEN')`,
      [ID.nexdCredential, ID.zeusCredential],
    )
    await db.query(
      `INSERT INTO external.campaign_link (id, campaign_id, source_id, credential_id, language) VALUES
         ($1, $4, 'nexd', $5, 'de'),
         ($2, $4, 'zeus', $6, 'de'),
         ($3, $4, 'zeus', $6, 'fr')`,
      [
        ID.nexdLink,
        ID.zeusLinkDe,
        ID.zeusLinkFr,
        ID.campaign,
        ID.nexdCredential,
        ID.zeusCredential,
      ],
    )
  })

  beforeEach(async () => {
    script = tracked
    active = 0
    maxActive = 0
    maxPerCredential = 0
    perCredential.clear()
    await db.query('DELETE FROM external.sync_run WHERE link_id = ANY($1::uuid[])', [OUR_LINKS])
    await db.query('DELETE FROM external.sync_state WHERE link_id = ANY($1::uuid[])', [OUR_LINKS])
    await db.query(
      `UPDATE app.campaign SET status = 'active', starts_on = '2026-08-01', ends_on = '2026-10-31'
        WHERE id = $1`,
      [ID.campaign],
    )
  })

  afterAll(async () => {
    await removeFixtures()
    await db.close()
  })

  it('syncs every eligible link: parallel across credentials, one at a time per credential', async () => {
    const summary = await pass(THURSDAY)

    expect(summary.deep).toBe(false)
    expect(statusByLink(summary.results)).toEqual({
      [ID.nexdLink]: 'succeeded',
      [ID.zeusLinkDe]: 'succeeded',
      [ID.zeusLinkFr]: 'succeeded',
    })
    expect(new Set(summary.results.map((r) => `${r.window.from}..${r.window.to}`))).toEqual(
      new Set(['2026-09-03..2026-09-09']),
    )
    expect(maxPerCredential).toBe(1)
    expect(maxActive).toBe(2)

    const runs = await db.query<{ trigger: string; status: string; window: string }>(
      `SELECT trigger, status, window_from || '..' || window_to AS window
         FROM external.sync_run WHERE link_id = ANY($1::uuid[])`,
      [OUR_LINKS],
    )
    expect(runs).toHaveLength(3)
    expect(new Set(runs.map((r) => `${r.trigger} ${r.status} ${r.window}`))).toEqual(
      new Set(['cron succeeded 2026-09-03..2026-09-09']),
    )
  })

  it('pulls the deep lookback on Sunday and records the deep sync', async () => {
    const summary = await pass(SUNDAY)

    expect(summary.deep).toBe(true)
    expect(Object.values(statusByLink(summary.results))).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ])
    expect(new Set(summary.results.map((r) => `${r.window.from}..${r.window.to}`))).toEqual(
      new Set(['2026-08-09..2026-09-12']),
    )
    const states = await db.query<{ deep: boolean }>(
      `SELECT last_deep_sync_at IS NOT NULL AS deep
         FROM external.sync_state WHERE link_id = ANY($1::uuid[])`,
      [OUR_LINKS],
    )
    expect(states).toEqual([{ deep: true }, { deep: true }, { deep: true }])
  })

  it.each([
    ['archived', `UPDATE app.campaign SET status = 'archived' WHERE id = $1`, 'campaign_archived'],
    [
      'not started yet',
      `UPDATE app.campaign SET starts_on = '2026-09-10' WHERE id = $1`,
      'campaign_not_started',
    ],
    [
      'finished before the deep lookback',
      `UPDATE app.campaign SET ends_on = '2026-08-05' WHERE id = $1`,
      'campaign_finished',
    ],
  ])('skips a campaign that is %s without opening a run', async (_name, statement, reason) => {
    await db.query(statement, [ID.campaign])

    const summary = await pass(THURSDAY)

    expect(summary.results).toEqual([])
    expect(summary.skipped.map((s) => s.reason)).toEqual([reason, reason, reason])
    expect(
      await db.query('SELECT 1 FROM external.sync_run WHERE link_id = ANY($1::uuid[])', [
        OUR_LINKS,
      ]),
    ).toEqual([])
  })

  it('keeps a campaign that ended inside the deep lookback, so restatements are still caught', async () => {
    await db.query(`UPDATE app.campaign SET ends_on = '2026-08-06' WHERE id = $1`, [ID.campaign])

    const summary = await pass(THURSDAY)

    expect(summary.skipped).toEqual([])
    expect(summary.results).toHaveLength(3)
  })

  it('never lets one failing link stop the others', async () => {
    script = async (ctx) => {
      if (ctx.link.id === ID.nexdLink) throw new Error('NEXD is down')
      return tracked(ctx)
    }

    const summary = await pass(THURSDAY)

    expect(statusByLink(summary.results)).toEqual({
      [ID.nexdLink]: 'failed',
      [ID.zeusLinkDe]: 'succeeded',
      [ID.zeusLinkFr]: 'succeeded',
    })
    expect(summary.results.find((r) => r.linkId === ID.nexdLink)?.outcome).toMatchObject({
      status: 'failed',
      code: 'internal',
      message: 'NEXD is down',
    })
  })

  it('stops the pass when the leader lease is lost', async () => {
    let checks = 0
    const lease: LeaderLease = {
      assertHeld: async () => {
        checks++
        if (checks > 1) throw new Error('leader lock 1 is no longer held')
      },
    }

    const summary = await pass(THURSDAY, lease)
    const outcomes = summary.results.map((r) => r.outcome)

    // Nothing is written after the loss: queued links never start, and the one already fetching
    // stops before its first day.
    expect(outcomes.filter((o) => o.status === 'succeeded')).toEqual([])
    expect(outcomes.some((o) => o.status === 'not_run' && o.reason === 'leader_lock_lost')).toBe(
      true,
    )
    const failed = outcomes.filter((o) => o.status === 'failed')
    expect(failed.map((o) => o.code)).toEqual(failed.map(() => 'aborted'))
  })
})
