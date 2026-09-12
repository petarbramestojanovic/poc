import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDb, type Db } from '../../src/db.ts'
import type { HttpClient } from '../../src/http/HttpClient.ts'
import { createLogger } from '../../src/log.ts'
import {
  InvalidLinkConfigError,
  LinkDisabledError,
  LinkNotFoundError,
  runSync,
  TooSoonError,
  UnknownTargetError,
  type SyncDeps,
} from '../../src/sync/engine.ts'
import { createRegistry } from '../../src/sync/registry.ts'
import type {
  CanonicalDailyRow,
  FetchResult,
  SourceConnector,
  SyncContext,
} from '../../src/sync/types.ts'
import { SEED } from './db.ts'

// A scripted connector standing in for Zeus on the seeded link: the engine is exercised
// against the real schema, the platform is not.
type Script = (ctx: SyncContext) => FetchResult

const row = (
  date: string,
  tag: string,
  over: Partial<CanonicalDailyRow> = {},
): CanonicalDailyRow => ({
  date,
  language: 'ignored-by-engine',
  campaignTag: tag,
  metrics: { impressions: 1000, in_view: 800, game_started: 50 },
  pageViews: [],
  ctaClicks: [{ ctaId: 'clickthrough', count: 10 }],
  unmapped: {},
  ...over,
})

const WINDOW = { from: '2026-09-01', to: '2026-09-02' }
const twoDays: Script = () => ({
  rows: [
    row('2026-09-01', 'mpu_v1'),
    // second entity, same tag → merged into the row above
    row('2026-09-01', 'mpu_v1', { metrics: { game_finished: 20 }, ctaClicks: [] }),
    // untagged row carrying only an unmatched pixel
    row('2026-09-01', '', { metrics: {}, ctaClicks: [], unmapped: { 'pixel 9999 "other"': 40 } }),
    row('2026-09-02', 'mpu_v1', {
      metrics: { impressions: 2000, in_view: 1500, game_started: 70, game_finished: 30 },
    }),
  ],
  raw: [
    {
      request: { method: 'GET', url: 'https://zeus.test/x' },
      response: { rows: [] },
      status: 200,
      fetchedAt: new Date().toISOString(),
    },
  ],
  warnings: ['fixture warning'],
})

const http: HttpClient = { request: () => Promise.reject(new Error('no network in this test')) }

interface AdvancedRow {
  campaign_tag: string
  events_date: string
  impressions: string | null
  game_finished: string | null
  sync_run_id: string
  language: string
  data_source: string
}

describe('sync engine', () => {
  let db: Db
  let script: Script = twoDays
  const connector: SourceConnector = {
    id: 'zeus',
    capabilities: {
      granularity: 'daily',
      restatementWindowDays: 7,
      maxWindowDays: 31,
      verifiesAgainstTotals: false,
    },
    identity: { levels: ['campaign', 'creative', 'pixel'], multiple: true },
    describe: () => ({ configSchema: z.looseObject({ clickthrough_cta_id: z.string() }) }),
    checkConnection: () => Promise.resolve({ ok: true, message: 'scripted' }),
    fetchWindow: (ctx) => Promise.resolve(script(ctx)),
  }
  let deps: SyncDeps

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4 })
    deps = {
      db,
      registry: createRegistry([connector]),
      http,
      log: createLogger('silent'),
      env: { ZEUS_API_TOKEN: 'scripted-token' },
    }
  })
  afterAll(() => db.close())

  beforeEach(async () => {
    script = twoDays
    for (const table of [
      'analytics.advanced_analytics',
      'analytics.page_views',
      'analytics.cta_clicks',
    ]) {
      await db.query(`DELETE FROM ${table} WHERE campaign_id = $1`, [SEED.campaignId])
    }
    for (const table of ['external.sync_run', 'external.sync_state', 'external.unmapped_event']) {
      await db.query(`DELETE FROM ${table} WHERE link_id = $1`, [SEED.zeusLinkId])
    }
  })

  const advanced = () =>
    db.query<AdvancedRow>(
      `SELECT campaign_tag, to_char(events_date, 'YYYY-MM-DD') AS events_date, impressions, game_finished,
              sync_run_id, language, data_source
         FROM analytics.advanced_analytics
        WHERE campaign_id = $1 AND source = 'zeus'
        ORDER BY events_date, campaign_tag`,
      [SEED.campaignId],
    )
  const ctaClicks = () =>
    db.query<{ events_date: string; cta_id: string; cta_counter: string }>(
      `SELECT to_char(events_date, 'YYYY-MM-DD') AS events_date, cta_id, cta_counter
         FROM analytics.cta_clicks WHERE campaign_id = $1 ORDER BY events_date`,
      [SEED.campaignId],
    )
  const state = async () =>
    (
      await db.query<{
        data_complete_through: string | null
        last_synced_at: Date | null
        cursor: unknown
      }>(
        `SELECT to_char(data_complete_through, 'YYYY-MM-DD') AS data_complete_through, last_synced_at, cursor
           FROM external.sync_state WHERE link_id = $1`,
        [SEED.zeusLinkId],
      )
    )[0]
  const run = async (id: string) =>
    (
      await db.query<{
        status: string
        days_written: number | null
        rows_written: number | null
        warnings: string[]
        error: string | null
        dry_run: boolean
      }>(
        'SELECT status, days_written, rows_written, warnings, error, dry_run FROM external.sync_run WHERE id = $1',
        [id],
      )
    )[0]

  it('writes merged day slices, raw payloads, unmapped events, sync_state and a succeeded run', async () => {
    const summary = await runSync(deps, {
      linkId: SEED.zeusLinkId,
      window: WINDOW,
      trigger: 'cron',
    })
    expect(summary).toMatchObject({
      dryRun: false,
      daysWritten: 2,
      rowsWritten: 4,
      warnings: ['fixture warning'],
    })

    expect(await advanced()).toEqual([
      {
        campaign_tag: 'mpu_v1',
        events_date: '2026-09-01',
        impressions: '1000',
        game_finished: '20',
        sync_run_id: summary.syncRunId,
        language: 'de',
        data_source: 'sync',
      },
      {
        campaign_tag: 'mpu_v1',
        events_date: '2026-09-02',
        impressions: '2000',
        game_finished: '30',
        sync_run_id: summary.syncRunId,
        language: 'de',
        data_source: 'sync',
      },
    ])
    expect(await ctaClicks()).toEqual([
      { events_date: '2026-09-01', cta_id: 'clickthrough', cta_counter: '10' },
      { events_date: '2026-09-02', cta_id: 'clickthrough', cta_counter: '10' },
    ])
    expect(
      await db.query('SELECT 1 FROM external.raw_payload WHERE sync_run_id = $1', [
        summary.syncRunId,
      ]),
    ).toHaveLength(1)
    expect(
      await db.query(
        'SELECT event_name, total_count FROM external.unmapped_event WHERE link_id = $1',
        [SEED.zeusLinkId],
      ),
    ).toEqual([{ event_name: 'pixel 9999 "other"', total_count: '40' }])
    expect(await state()).toMatchObject({
      data_complete_through: '2026-09-02',
      cursor: { lastWindow: WINDOW, lastRunId: summary.syncRunId },
    })
    expect(await run(summary.syncRunId)).toMatchObject({
      status: 'succeeded',
      days_written: 2,
      rows_written: 4,
      warnings: ['fixture warning'],
      dry_run: false,
    })
  })

  it('is idempotent: re-running the same window leaves the same rows', async () => {
    await runSync(deps, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' })
    const second = await runSync(deps, {
      linkId: SEED.zeusLinkId,
      window: WINDOW,
      trigger: 'backfill',
    })
    const rows = await advanced()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.sync_run_id === second.syncRunId)).toBe(true)
    expect(rows.map((r) => r.impressions)).toEqual(['1000', '2000'])
    expect(await ctaClicks()).toHaveLength(2)
  })

  it('replaces a restated day completely: a dropped CTA disappears, other days untouched', async () => {
    const first = await runSync(deps, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' })
    script = () => ({
      rows: [
        row('2026-09-02', 'mpu_v1', {
          metrics: { impressions: 1900, in_view: 1400 },
          ctaClicks: [],
        }),
      ],
      raw: [],
      warnings: [],
    })
    await runSync(deps, {
      linkId: SEED.zeusLinkId,
      window: { from: '2026-09-02', to: '2026-09-02' },
      trigger: 'backfill',
    })

    const rows = await advanced()
    expect(rows.map((r) => [r.events_date, r.impressions, r.game_finished])).toEqual([
      ['2026-09-01', '1000', '20'],
      ['2026-09-02', '1900', null],
    ])
    expect(rows[0]?.sync_run_id).toBe(first.syncRunId)
    expect(await ctaClicks()).toEqual([
      { events_date: '2026-09-01', cta_id: 'clickthrough', cta_counter: '10' },
    ])
  })

  it('aborts on a failing entity fetch: prior rows intact, sync_state not advanced, run failed', async () => {
    const first = await runSync(deps, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' })
    const before = { rows: await advanced(), state: await state() }

    script = () => {
      throw new Error('Zeus returned 502 for creative 12346')
    }
    await expect(
      runSync(deps, {
        linkId: SEED.zeusLinkId,
        window: { from: '2026-09-01', to: '2026-09-05' },
        trigger: 'cron',
      }),
    ).rejects.toThrow('502')

    expect(await advanced()).toEqual(before.rows)
    expect(await state()).toEqual(before.state)
    const runs = await db.query<{ id: string; status: string; error: string | null }>(
      'SELECT id, status, error FROM external.sync_run WHERE link_id = $1 ORDER BY started_at',
      [SEED.zeusLinkId],
    )
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'failed'])
    expect(runs[0]?.id).toBe(first.syncRunId)
    expect(runs[1]?.error).toBe('Error: Zeus returned 502 for creative 12346')
  })

  it('dry run returns a diff and writes nothing', async () => {
    await runSync(deps, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' })
    script = () => ({
      rows: [
        row('2026-09-01', 'mpu_v1', {
          metrics: { impressions: 1500, in_view: 800, game_started: 50 },
        }),
      ],
      raw: [],
      warnings: [],
    })
    const summary = await runSync(deps, {
      linkId: SEED.zeusLinkId,
      window: { from: '2026-09-01', to: '2026-09-01' },
      trigger: 'manual',
      dryRun: true,
    })
    expect(summary.diff).toEqual([
      {
        date: '2026-09-01',
        rows: { before: 1, after: 1 },
        metrics: {
          impressions: { before: 1000, after: 1500 },
          in_view: { before: 800, after: 800 },
          game_started: { before: 50, after: 50 },
          game_finished: { before: 20, after: null },
        },
        pageViews: { before: 0, after: 0 },
        ctaClicks: { before: 10, after: 10 },
      },
    ])
    expect((await advanced()).map((r) => r.impressions)).toEqual(['1000', '2000'])
    expect(await run(summary.syncRunId)).toMatchObject({
      status: 'succeeded',
      dry_run: true,
      days_written: 0,
    })
  })

  it('enforces the manual-run cooldown but not for cron, backfill or dry runs', async () => {
    const request = { linkId: SEED.zeusLinkId, window: WINDOW }
    await runSync(deps, { ...request, trigger: 'manual' })
    await expect(runSync(deps, { ...request, trigger: 'manual' })).rejects.toThrow(TooSoonError)
    await expect(runSync(deps, { ...request, trigger: 'cron' })).resolves.toBeDefined()
    await expect(runSync(deps, { ...request, trigger: 'backfill' })).resolves.toBeDefined()
    await expect(
      runSync(deps, { ...request, trigger: 'manual', dryRun: true }),
    ).resolves.toBeDefined()
    await db.query(
      `UPDATE external.sync_run SET started_at = started_at - interval '6 minutes' WHERE link_id = $1`,
      [SEED.zeusLinkId],
    )
    await expect(runSync(deps, { ...request, trigger: 'manual' })).resolves.toBeDefined()
  })

  it('fails before writing when rows reference unknown CTAs or fall outside the window', async () => {
    script = () => ({
      rows: [row('2026-09-01', 'x', { ctaClicks: [{ ctaId: 'nope', count: 1 }] })],
      raw: [],
      warnings: [],
    })
    await expect(
      runSync(deps, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' }),
    ).rejects.toThrow(UnknownTargetError)
    script = () => ({ rows: [row('2026-08-01', 'x')], raw: [], warnings: [] })
    await expect(
      runSync(deps, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' }),
    ).rejects.toThrow(/outside/)
    expect(await advanced()).toEqual([])
    const runs = await db.query<{ status: string }>(
      'SELECT status FROM external.sync_run WHERE link_id = $1',
      [SEED.zeusLinkId],
    )
    expect(runs.map((r) => r.status)).toEqual(['failed', 'failed'])
  })

  it('rejects unknown, disabled or misconfigured links without creating a run', async () => {
    const unknownId = '00000000-0000-4000-8000-0000000000ff'
    await expect(
      runSync(deps, { linkId: unknownId, window: WINDOW, trigger: 'cron' }),
    ).rejects.toThrow(LinkNotFoundError)
    await expect(
      runSync(deps, { linkId: SEED.nexdLinkId, window: WINDOW, trigger: 'cron' }),
    ).rejects.toThrow(/No connector registered/)

    await db.query('UPDATE external.campaign_link SET enabled = false WHERE id = $1', [
      SEED.zeusLinkId,
    ])
    await expect(
      runSync(deps, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' }),
    ).rejects.toThrow(LinkDisabledError)
    await db.query(
      `UPDATE external.campaign_link SET enabled = true, config = '{}' WHERE id = $1`,
      [SEED.zeusLinkId],
    )
    await expect(
      runSync(deps, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' }),
    ).rejects.toThrow(InvalidLinkConfigError)
    await db.query(
      `UPDATE external.campaign_link SET config = '{"clickthrough_cta_id": "clickthrough"}' WHERE id = $1`,
      [SEED.zeusLinkId],
    )

    expect(
      await db.query('SELECT 1 FROM external.sync_run WHERE link_id = $1', [SEED.zeusLinkId]),
    ).toEqual([])
  })

  it('records a missing secret as a failed run', async () => {
    await expect(
      runSync({ ...deps, env: {} }, { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron' }),
    ).rejects.toThrow('ZEUS_API_TOKEN')
    const runs = await db.query<{ status: string; error: string }>(
      'SELECT status, error FROM external.sync_run WHERE link_id = $1',
      [SEED.zeusLinkId],
    )
    expect(runs).toEqual([
      {
        status: 'failed',
        error: 'MissingSecretError: Environment variable ZEUS_API_TOKEN is not set',
      },
    ])
  })
})
