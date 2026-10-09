import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDb, type Db } from '../../src/core/db.ts'
import type { HttpClient } from '../../src/core/http/HttpClient.ts'
import { createLimiter } from '../../src/core/limiter.ts'
import { createLogger } from '../../src/core/log.ts'
import {
  InvalidLinkConfigError,
  LinkDisabledError,
  LinkNotFoundError,
  RegistryMismatchError,
  RowOutOfWindowError,
  runSync,
  RunInProgressError,
  SYNC_MAX_CONNECTIONS,
  SyncAbortedError,
  SyncError,
  TooSoonError,
  UnknownTargetError,
  verifyRegistryAgainstSources,
  type SyncDeps,
} from '../../src/modules/sync/engine.ts'
import { createRegistry } from '../../src/modules/sync/registry.ts'
import {
  METRIC_AGGREGATION,
  METRIC_IDS,
  METRIC_WEIGHT,
  type CanonicalDailyRow,
  type FetchResult,
  type MetricId,
  type SourceConnector,
  type SyncContext,
} from '../../src/modules/sync/types.ts'
import { SEED } from './db.ts'

// A scripted connector standing in for Zeus on the seeded link: the engine is exercised
// against the real schema, the platform is not.
type Script = (ctx: SyncContext) => FetchResult | Promise<FetchResult>

const WINDOW = { from: '2026-09-01', to: '2026-09-02' }

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
  unmapped: new Map(),
  ...over,
})

const capture = (ctx: SyncContext) =>
  ctx.capture({
    request: { method: 'GET', url: 'https://zeus.test/x' },
    response: { rows: [] },
    status: 200,
    fetchedAt: new Date().toISOString(),
  })

const twoDays: Script = async (ctx) => {
  await capture(ctx)
  return {
    rows: [
      row('2026-09-01', 'mpu_v1', { pageViews: [{ pageId: 'result', count: 5 }] }),
      // second entity, same tag → merged into the row above
      row('2026-09-01', 'mpu_v1', { metrics: { game_finished: 20 }, ctaClicks: [] }),
      // untagged row carrying only an unmatched pixel
      row('2026-09-01', '', {
        metrics: {},
        ctaClicks: [],
        unmapped: new Map([['pixel 9999 "other"', 40]]),
      }),
      row('2026-09-02', 'mpu_v1', {
        metrics: { impressions: 2000, in_view: 1500, game_started: 70, game_finished: 30 },
      }),
    ],
    warnings: ['fixture warning'],
    covered: WINDOW,
  }
}

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
  let originalConfig: unknown
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
    fetchWindow: async (ctx) => script(ctx),
  }
  let deps: SyncDeps

  const cleanup = async () => {
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
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 6, ssl: 'disable' })
    deps = {
      db,
      registry: createRegistry([connector]),
      http,
      log: createLogger('silent'),
      limiter: createLimiter(SYNC_MAX_CONNECTIONS),
      env: { ZEUS_API_TOKEN: 'scripted-token' },
    }
    const [link] = await db.query<{ config: unknown }>(
      'SELECT config FROM external.campaign_link WHERE id = $1',
      [SEED.zeusLinkId],
    )
    originalConfig = link?.config
  })
  beforeEach(async () => {
    script = twoDays
    await cleanup()
  })
  // Restore the shared seed unconditionally, even when a test failed halfway through mutating it.
  afterEach(async () => {
    await db.query(
      'UPDATE external.campaign_link SET enabled = true, config = $2::jsonb WHERE id = $1',
      [SEED.zeusLinkId, JSON.stringify(originalConfig)],
    )
  })
  // Leave nothing behind for the next test file.
  afterAll(async () => {
    await cleanup()
    await db.close()
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
  const pageViews = () =>
    db.query<{ events_date: string; campaign_tag: string; page_id: string; view_counter: string }>(
      `SELECT events_date, campaign_tag, page_id, view_counter
         FROM analytics.page_views WHERE campaign_id = $1 ORDER BY events_date`,
      [SEED.campaignId],
    )
  const state = async () =>
    (
      await db.query<{
        data_complete_through: string | null
        last_synced_at: Date | null
        last_deep_sync_at: Date | null
        cursor: unknown
      }>(
        `SELECT data_complete_through, last_synced_at, last_deep_sync_at, cursor
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
        triggered_by: string | null
      }>(
        'SELECT status, days_written, rows_written, warnings, error, dry_run, triggered_by FROM external.sync_run WHERE id = $1',
        [id],
      )
    )[0]
  const sync = (
    over: Partial<Parameters<typeof runSync>[1]> = {},
    depsOver: Partial<SyncDeps> = {},
  ) =>
    runSync(
      { ...deps, ...depsOver },
      { linkId: SEED.zeusLinkId, window: WINDOW, trigger: 'cron', ...over },
    )

  it('writes merged day slices, page views, raw payloads, unmapped events, sync_state and a succeeded run', async () => {
    const summary = await sync()
    expect(summary).toMatchObject({
      dryRun: false,
      daysWritten: 2,
      rowsWritten: 5,
      rowsDeleted: 0,
      httpCalls: 1,
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
    expect(await pageViews()).toEqual([
      { events_date: '2026-09-01', campaign_tag: 'mpu_v1', page_id: 'result', view_counter: '5' },
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
      last_deep_sync_at: null,
      cursor: { lastWindow: WINDOW, lastRunId: summary.syncRunId },
    })
    expect(await run(summary.syncRunId)).toMatchObject({
      status: 'succeeded',
      days_written: 2,
      rows_written: 5,
      warnings: ['fixture warning'],
      dry_run: false,
    })
  })

  it('syncs a window that runs into today only through yesterday, and refuses one with no complete day', async () => {
    // 10:00 UTC on 09-02: that day is still being counted, so 09-01 is the newest complete one.
    const now = () => new Date('2026-09-02T10:00:00Z')
    let asked: { from: string; to: string } | undefined
    script = (ctx) => {
      asked = ctx.window
      return { rows: [row('2026-09-01', 'mpu_v1')], warnings: [], covered: ctx.window }
    }

    const summary = await sync({}, { now })

    expect(asked).toEqual({ from: '2026-09-01', to: '2026-09-01' })
    expect(summary.warnings).toContain(
      'window end 2026-09-02 is not a complete day yet; synced through 2026-09-01 (UTC)',
    )
    expect((await state())?.data_complete_through).toBe('2026-09-01')
    const [recorded] = await db.query<{ window_to: string }>(
      'SELECT window_to FROM external.sync_run WHERE id = $1',
      [summary.syncRunId],
    )
    expect(recorded?.window_to).toBe('2026-09-01')

    await expect(
      sync({ window: { from: '2026-09-02', to: '2026-09-30' } }, { now }),
    ).rejects.toMatchObject({ code: 'window_not_complete', status: 422 })
    // Refused before a run was opened: the only run is the first one.
    const [runs] = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM external.sync_run WHERE link_id = $1',
      [SEED.zeusLinkId],
    )
    expect(runs?.n).toBe(1)
    expect((await state())?.data_complete_through).toBe('2026-09-01')
  })

  it('records the deep flag and the triggering user', async () => {
    const userId = '00000000-0000-4000-8000-0000000000aa'
    const summary = await sync({ deep: true, trigger: 'backfill', triggeredBy: userId })
    expect((await state())?.last_deep_sync_at).toBeInstanceOf(Date)
    expect(await run(summary.syncRunId)).toMatchObject({ triggered_by: userId })
  })

  it('writes every metric into its own column (METRIC_IDS order matches insert_advanced.sql)', async () => {
    const values = Object.fromEntries(METRIC_IDS.map((id, i) => [id, (i + 1) * 11])) as Record<
      MetricId,
      number
    >
    values.dwell_avg_ms = 1234.5
    script = () => ({
      rows: [row('2026-09-01', 'all', { metrics: values, ctaClicks: [] })],
      warnings: [],
      covered: { from: '2026-09-01', to: '2026-09-01' },
    })
    await sync({ window: { from: '2026-09-01', to: '2026-09-01' } })
    const [stored] = await db.query<Record<string, string>>(
      `SELECT ${METRIC_IDS.join(', ')} FROM analytics.advanced_analytics WHERE campaign_id = $1 AND source = 'zeus'`,
      [SEED.campaignId],
    )
    for (const id of METRIC_IDS) expect(Number(stored?.[id]), id).toBe(values[id])
  })

  it('mirrors analytics.metric: aggregation and weight maps cannot drift from the database', async () => {
    const rows = await db.query<{
      id: MetricId
      aggregation: string
      weight_metric: string | null
    }>(
      `SELECT id, aggregation, weight_metric FROM analytics.metric WHERE table_name = 'advanced_analytics'`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.id, r.aggregation]))).toEqual(METRIC_AGGREGATION)
    expect(
      Object.fromEntries(
        rows.filter((r) => r.weight_metric !== null).map((r) => [r.id, r.weight_metric]),
      ),
    ).toEqual(METRIC_WEIGHT)
    expect(rows.map((r) => r.id).sort()).toEqual([...METRIC_IDS].sort())
  })

  it('is idempotent: re-running the same window leaves the same rows and does not inflate unmapped counts', async () => {
    await sync()
    const second = await sync({ trigger: 'backfill' })
    const rows = await advanced()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.sync_run_id === second.syncRunId)).toBe(true)
    expect(rows.map((r) => r.impressions)).toEqual(['1000', '2000'])
    expect(await ctaClicks()).toHaveLength(2)
    expect(
      await db.query('SELECT total_count FROM external.unmapped_event WHERE link_id = $1', [
        SEED.zeusLinkId,
      ]),
    ).toEqual([{ total_count: '40' }])
  })

  it('replaces a restated day completely: a dropped CTA disappears, other days untouched', async () => {
    const first = await sync()
    script = () => ({
      rows: [
        row('2026-09-02', 'mpu_v1', {
          metrics: { impressions: 1900, in_view: 1400 },
          ctaClicks: [],
        }),
      ],
      warnings: [],
      covered: { from: '2026-09-02', to: '2026-09-02' },
    })
    await sync({ window: { from: '2026-09-02', to: '2026-09-02' }, trigger: 'backfill' })

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

  it('clears a day inside the covered window that the source no longer reports', async () => {
    await sync()
    script = () => ({ rows: [row('2026-09-01', 'mpu_v1')], warnings: [], covered: WINDOW })
    const second = await sync({ trigger: 'backfill' })

    expect((await advanced()).map((r) => r.events_date)).toEqual(['2026-09-01'])
    expect((await ctaClicks()).map((r) => r.events_date)).toEqual(['2026-09-01'])
    expect(await pageViews()).toEqual([])
    expect(second).toMatchObject({ daysWritten: 2 })
    expect(second.rowsDeleted).toBeGreaterThan(0)
  })

  it('never touches days outside the covered window, even inside the requested one', async () => {
    await sync()
    // e.g. Zeus clamped the end of the window to yesterday
    script = () => ({
      rows: [row('2026-09-01', 'mpu_v1', { metrics: { impressions: 5 } })],
      warnings: [],
      covered: { from: '2026-09-01', to: '2026-09-01' },
    })
    await sync({ trigger: 'backfill' })
    expect((await advanced()).map((r) => [r.events_date, r.impressions])).toEqual([
      ['2026-09-01', '5'],
      ['2026-09-02', '2000'],
    ])
    expect((await state())?.data_complete_through).toBe('2026-09-02')
  })

  it('aborts on a failing fetch: prior rows intact, sync_state not advanced, payloads kept, run failed', async () => {
    const first = await sync()
    const before = { rows: await advanced(), state: await state() }

    script = async (ctx) => {
      await capture(ctx)
      throw new Error('Zeus returned 502 for creative 12346')
    }
    await expect(sync({ window: { from: '2026-09-01', to: '2026-09-05' } })).rejects.toThrow('502')

    expect(await advanced()).toEqual(before.rows)
    expect(await state()).toEqual(before.state)
    const runs = await db.query<{ id: string; status: string; error: string | null }>(
      'SELECT id, status, error FROM external.sync_run WHERE link_id = $1 ORDER BY started_at',
      [SEED.zeusLinkId],
    )
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'failed'])
    expect(runs[0]?.id).toBe(first.syncRunId)
    expect(runs[1]?.error).toBe('Error [internal]: Zeus returned 502 for creative 12346')
    // The response captured before the failure is kept for debugging.
    expect(
      await db.query('SELECT 1 FROM external.raw_payload WHERE sync_run_id = $1', [runs[1]?.id]),
    ).toHaveLength(1)
  })

  it('stops between days on shutdown, records the run as aborted and does not advance the cursor', async () => {
    await sync()
    const before = await state()
    const controller = new AbortController()
    script = () => {
      controller.abort(new Error('SIGTERM'))
      return {
        rows: [row('2026-09-01', 'mpu_v1', { metrics: { impressions: 7 } })],
        warnings: [],
        covered: WINDOW,
      }
    }
    await expect(sync({ trigger: 'backfill' }, { signal: controller.signal })).rejects.toThrow(
      SyncAbortedError,
    )
    expect((await advanced()).map((r) => r.impressions)).toEqual(['1000', '2000'])
    expect(await state()).toEqual(before)
    const [last] = await db.query<{ status: string; error: string }>(
      `SELECT status, error FROM external.sync_run WHERE link_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [SEED.zeusLinkId],
    )
    expect(last?.status).toBe('failed')
    expect(last?.error).toMatch(/^SyncAbortedError \[aborted\]/)

    const aborted = new AbortController()
    aborted.abort(new Error('SIGTERM'))
    await expect(sync({ trigger: 'backfill' }, { signal: aborted.signal })).rejects.toThrow(
      SyncAbortedError,
    )
  })

  it('dry run returns an aggregation-aware diff over every covered day and writes nothing', async () => {
    await sync()
    script = () => ({
      rows: [
        row('2026-09-01', 'mpu_v1', {
          metrics: { impressions: 1500, in_view: 800, game_started: 50 },
        }),
      ],
      warnings: [],
      covered: { from: '2026-09-01', to: '2026-09-01' },
    })
    const summary = await sync({
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
        perTag: {},
        pageViews: { before: 5, after: 0 },
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
    await sync({ trigger: 'manual' })
    await expect(sync({ trigger: 'manual' })).rejects.toThrow(TooSoonError)
    await expect(sync({ trigger: 'cron' })).resolves.toBeDefined()
    await expect(sync({ trigger: 'backfill' })).resolves.toBeDefined()
    await expect(sync({ trigger: 'manual', dryRun: true })).resolves.toBeDefined()
    await db.query(
      `UPDATE external.sync_run SET started_at = started_at - interval '6 minutes' WHERE link_id = $1`,
      [SEED.zeusLinkId],
    )
    await expect(sync({ trigger: 'manual' })).resolves.toBeDefined()
  })

  it('lets exactly one of two simultaneous manual triggers through', async () => {
    const results = await Promise.allSettled([
      sync({ trigger: 'manual' }),
      sync({ trigger: 'manual' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const [rejected] = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(SyncError)
    expect(['too_soon', 'run_in_progress']).toContain((rejected?.reason as SyncError).code)
  })

  it('refuses a real run while another is running, unless that run is abandoned', async () => {
    await db.query(
      `INSERT INTO external.sync_run (link_id, trigger, window_from, window_to, status) VALUES ($1, 'cron', '2026-09-01', '2026-09-02', 'running')`,
      [SEED.zeusLinkId],
    )
    await expect(sync()).rejects.toThrow(RunInProgressError)
    await expect(sync({ dryRun: true })).resolves.toBeDefined()
    await db.query(
      `UPDATE external.sync_run SET started_at = now() - interval '7 hours' WHERE link_id = $1 AND status = 'running'`,
      [SEED.zeusLinkId],
    )
    await expect(sync()).resolves.toBeDefined()
  })

  it('fails before writing when rows reference unknown CTAs, invalid days or fall outside the covered window', async () => {
    script = () => ({
      rows: [row('2026-09-01', 'x', { ctaClicks: [{ ctaId: 'nope', count: 1 }] })],
      warnings: [],
      covered: WINDOW,
    })
    await expect(sync()).rejects.toThrow(UnknownTargetError)
    script = () => ({ rows: [row('2026-08-01', 'x')], warnings: [], covered: WINDOW })
    await expect(sync()).rejects.toThrow(RowOutOfWindowError)
    script = () => ({
      rows: [row('2026-09-01', 'x')],
      warnings: [],
      covered: { from: '2026-08-01', to: '2026-09-02' },
    })
    await expect(sync()).rejects.toThrow(RowOutOfWindowError)
    script = () => ({ rows: [row('2026-02-31', 'x')], warnings: [], covered: WINDOW })
    await expect(sync()).rejects.toThrow('invalid day')
    expect(await advanced()).toEqual([])
    const runs = await db.query<{ status: string }>(
      'SELECT status FROM external.sync_run WHERE link_id = $1',
      [SEED.zeusLinkId],
    )
    expect(runs.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'failed'])
  })

  it('rejects unknown, disabled or misconfigured links without creating a run', async () => {
    await expect(sync({ linkId: '00000000-0000-4000-8000-0000000000ff' })).rejects.toThrow(
      LinkNotFoundError,
    )
    await expect(sync({ linkId: SEED.nexdLinkId })).rejects.toThrow(/No connector registered/)

    await db.query('UPDATE external.campaign_link SET enabled = false WHERE id = $1', [
      SEED.zeusLinkId,
    ])
    await expect(sync()).rejects.toThrow(LinkDisabledError)
    await db.query(
      `UPDATE external.campaign_link SET enabled = true, config = '{}' WHERE id = $1`,
      [SEED.zeusLinkId],
    )
    const error = await sync().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvalidLinkConfigError)
    expect((error as InvalidLinkConfigError).issues.map((i) => i.path)).toEqual([
      'clickthrough_cta_id',
    ])

    expect(
      await db.query('SELECT 1 FROM external.sync_run WHERE link_id = $1', [SEED.zeusLinkId]),
    ).toEqual([])
  })

  it('records a missing secret as a failed run with a typed, redacted error', async () => {
    await expect(sync({}, { env: {} })).rejects.toThrow('ZEUS_API_TOKEN')
    const runs = await db.query<{ status: string; error: string }>(
      'SELECT status, error FROM external.sync_run WHERE link_id = $1',
      [SEED.zeusLinkId],
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('failed')
    expect(runs[0]?.error).toMatch(
      /^CredentialUnavailableError \[credential_unavailable\]: .*ZEUS_API_TOKEN/,
    )
  })

  it('boot check: the registry must match the enabled platform sources', async () => {
    await expect(verifyRegistryAgainstSources(db, deps.registry)).rejects.toThrow(
      RegistryMismatchError,
    )
    const both = createRegistry([connector, { ...connector, id: 'nexd' }])
    await expect(verifyRegistryAgainstSources(db, both)).resolves.toBeUndefined()
  })
})
