import { beforeEach, describe, expect, it } from 'vitest'
import {
  webhookPayloadSchema,
  type WebhookSourceBlock,
} from '../../src/modules/webhooks/payload.ts'
import { at } from '../helpers.ts'
import { SEED, useTransactionalClient } from './db.ts'

// Migration 0003: the RFC-004 §7 read functions and the webhook payload they feed. Every row here
// is written inside the test transaction and rolled back, on top of the seeded dev campaign
// (primary_source 'zeus', a nexd and a zeus link, two pages and one CTA).
//
// The fixture is built so that the rules can actually be broken:
//   * both sources hold rows for the same campaign and days — a function that summed across
//     sources would report 4100 impressions instead of 600 (zeus) or 3500 (nexd),
//   * dwell_avg_ms differs per day and per creative, and its weighted average (1500) is not its
//     plain average (1166.67),
//   * 2026-09-01 has two creatives reporting unique_impressions_reported, 2026-09-02 has one.

const CAMPAIGN = SEED.campaignId
const FR_LINK = '00000000-0000-4000-8000-0000000009f1'
const EMPTY_CAMPAIGN = '00000000-0000-4000-8000-0000000009e0'
const WEBHOOK = '00000000-0000-4000-8000-0000000009a0'
const EMPTY_WEBHOOK = '00000000-0000-4000-8000-0000000009a1'

const FROM = '2026-09-01'
const TO = '2026-09-03'

/** Numbers arrive as strings for bigint and numeric columns, so every read goes through Number(). */
type Row = Record<string, string | number | boolean | string[] | Date | null>

describe('migration 0003_read_functions', () => {
  const { sql } = useTransactionalClient()

  beforeEach(async () => {
    // nexd: two creatives, dwell measured, and one day where a metric was not reported at all.
    await sql(
      `INSERT INTO analytics.advanced_analytics
         (campaign_id, source, language, campaign_tag, events_date,
          impressions, in_view, game_started, interactions, dwell_avg_ms,
          unique_impressions_reported, data_source)
       VALUES
         ($1, 'nexd', 'de', 'nx_dev_v1', '2026-09-01', 1000,  800, 100,   50, 1000.00,  700, 'sync'),
         ($1, 'nexd', 'de', 'nx_dev_v1', '2026-09-02', 2000, 1500, 300, NULL, 2000.00, 1200, 'sync'),
         ($1, 'nexd', 'de', 'nx_dev_v2', '2026-09-01',  500,  400, 100,   25,  500.00,  300, 'sync')`,
      [CAMPAIGN],
    )
    // zeus: no pixels configured, so game_started stays NULL — measured, not reported, never 0.
    await sql(
      `INSERT INTO analytics.advanced_analytics
         (campaign_id, source, language, campaign_tag, events_date,
          impressions, in_view, game_started, unique_clicks_reported, data_source)
       VALUES
         ($1, 'zeus', 'de', 'mpu_v1', '2026-09-01', 100,  90, NULL, 10, 'sync'),
         ($1, 'zeus', 'de', 'mpu_v2', '2026-09-01', 200, 180, NULL, 20, 'sync'),
         ($1, 'zeus', 'de', 'mpu_v1', '2026-09-02', 300, 270, NULL, 30, 'sync')`,
      [CAMPAIGN],
    )
    await sql(
      `INSERT INTO analytics.page_views
         (campaign_id, source, language, campaign_tag, page_id, events_date, view_counter, data_source)
       VALUES
         ($1, 'nexd', 'de', 'nx_dev_v1', 'main',   '2026-09-01', 400, 'sync'),
         ($1, 'nexd', 'de', 'nx_dev_v1', 'main',   '2026-09-02', 600, 'sync'),
         ($1, 'nexd', 'de', 'nx_dev_v1', 'result', '2026-09-01', 150, 'sync')`,
      [CAMPAIGN],
    )
    await sql(
      `INSERT INTO analytics.cta_clicks
         (campaign_id, source, language, campaign_tag, cta_id, events_date, cta_counter, data_source)
       VALUES
         ($1, 'nexd', 'de', 'nx_dev_v1', 'clickthrough', '2026-09-01', 30, 'sync'),
         ($1, 'zeus', 'de', 'mpu_v1',    'clickthrough', '2026-09-01',  7, 'sync')`,
      [CAMPAIGN],
    )
    await sql(
      `INSERT INTO external.sync_state (link_id, data_complete_through, last_synced_at) VALUES
         ($1, '2026-09-03', '2026-09-04T02:10:00Z'),
         ($2, '2026-09-02', '2026-09-04T02:20:00Z')`,
      [SEED.zeusLinkId, SEED.nexdLinkId],
    )
  })

  const call = (fn: string, source: string | null, campaign: string = CAMPAIGN): Promise<Row[]> =>
    sql<Row>(`SELECT * FROM analytics.${fn}($1, $2, $3, $4)`, [campaign, FROM, TO, source])

  const totalsFor = async (source: string | null, campaign: string = CAMPAIGN): Promise<Row> =>
    at(await call('get_engagement_totals', source, campaign))

  /** A second campaign of the same company with no analytics rows and no sync state. */
  const emptyCampaign = async (): Promise<string> => {
    await sql(
      `INSERT INTO app.campaign (id, company_id, name, primary_source, languages)
       VALUES ($1, $2, 'DEV0002 Empty Campaign', 'nexd', '{de}')
       ON CONFLICT (id) DO NOTHING`,
      [EMPTY_CAMPAIGN, SEED.companyId],
    )
    return EMPTY_CAMPAIGN
  }

  describe('analytics.get_engagement_totals', () => {
    it('sums the dailies for every sum-metric', async () => {
      const daily = await call('get_engagement_daily', 'nexd')
      const totals = await totalsFor('nexd')

      for (const metric of ['impressions', 'in_view', 'game_started', 'interactions']) {
        const expected = daily.reduce((sum, row) => sum + Number(row[metric] ?? 0), 0)
        expect(Number(totals[metric]), metric).toBe(expected)
      }
      expect(Number(totals.impressions)).toBe(3500)
    })

    it('leaves unique_*_reported null: a per-day scalar is never added up', async () => {
      const nexd = await totalsFor('nexd')
      const zeus = await totalsFor('zeus')

      expect(nexd.unique_impressions_reported).toBeNull()
      expect(zeus.unique_clicks_reported).toBeNull()
      // ...while the days themselves still carry the reported values.
      const days = await call('get_engagement_daily', 'zeus')
      expect(days.map((row) => Number(row.unique_clicks_reported))).toEqual([10, 20, 30])
    })

    it('averages dwell_avg_ms weighted by game_started', async () => {
      const totals = await totalsFor('nexd')
      // (100·1000 + 300·2000 + 100·500) / 500 = 1500, not the plain mean 1166.67.
      expect(Number(totals.dwell_avg_ms)).toBe(1500)
    })

    it('reports a measured but unreported metric as null, never as zero', async () => {
      const zeus = await totalsFor('zeus')
      expect(zeus.game_started).toBeNull()
    })

    it('answers for one source only and defaults to the campaign primary', async () => {
      const zeus = await totalsFor('zeus')
      const nexd = await totalsFor('nexd')
      const fallback = await totalsFor(null)

      expect(Number(zeus.impressions)).toBe(600)
      expect(Number(nexd.impressions)).toBe(3500)
      expect(fallback).toEqual(zeus) // app.campaign.primary_source = 'zeus'
    })

    it('returns nulls, not zeros, for a source with no rows', async () => {
      const totals = await totalsFor('nexd', await emptyCampaign())
      expect(Object.values(totals).every((value) => value === null)).toBe(true)
    })
  })

  describe('analytics.get_engagement_daily', () => {
    it('returns one row per date, language and creative, in order', async () => {
      const rows = await call('get_engagement_daily', 'nexd')

      expect(rows.map((row) => [row.events_date, row.language, row.campaign_tag])).toEqual([
        ['2026-09-01', 'de', 'nx_dev_v1'],
        ['2026-09-01', 'de', 'nx_dev_v2'],
        ['2026-09-02', 'de', 'nx_dev_v1'],
      ])
      // The stored per-day average is handed over untouched.
      expect(Number(at(rows).dwell_avg_ms)).toBe(1000)
    })

    it('honours the window boundaries', async () => {
      const rows = await sql('SELECT * FROM analytics.get_engagement_daily($1, $2, $3, $4)', [
        CAMPAIGN,
        '2026-09-02',
        '2026-09-02',
        'nexd',
      ])
      expect(rows).toHaveLength(1)
    })
  })

  describe('analytics.get_creative_breakdown', () => {
    it('labels each creative from external.link_entity', async () => {
      const rows = await call('get_creative_breakdown', 'nexd')

      expect(rows.map((row) => [row.campaign_tag, row.label])).toEqual([
        ['nx_dev_v1', 'Dev creative V1'],
        ['nx_dev_v2', 'Dev creative V2'],
      ])
      expect(Number(at(rows).impressions)).toBe(3000)
      expect(at(rows).unique_impressions_reported).toBeNull()
    })

    it('leaves the label null for a tag no entity claims', async () => {
      const rows = await call('get_creative_breakdown', 'zeus')

      expect(rows.map((row) => [row.campaign_tag, row.label])).toEqual([
        ['mpu_v1', 'Dev MPU V1'],
        ['mpu_v2', null],
      ])
    })
  })

  describe('analytics.get_page_views and get_cta_clicks', () => {
    it('sums per page over the window, ordered by sort_order', async () => {
      const rows = await call('get_page_views', 'nexd')

      expect(rows.map((row) => [row.page_id, Number(row.view_counter)])).toEqual([
        ['main', 1000],
        ['result', 150],
      ])
    })

    it('counts CTA clicks per source, never merged', async () => {
      const nexd = at(await call('get_cta_clicks', 'nexd'))
      const zeus = at(await call('get_cta_clicks', 'zeus'))

      expect(Number(nexd.cta_counter)).toBe(30)
      expect(Number(zeus.cta_counter)).toBe(7)
      expect(nexd.name).toBe('Click-out')
    })
  })

  describe('analytics.get_source_status', () => {
    it('lists what the source measures and how far it is complete', async () => {
      const status = at(await call('get_source_status', 'zeus'))

      expect(status.source).toBe('zeus')
      expect(status.day_timezone).toBe('UTC')
      expect(status.metrics_available).toContain('unique_clicks_reported')
      expect(status.metrics_available).not.toContain('dwell_avg_ms')
      expect(status.data_complete_through).toBe('2026-09-03')
    })

    it('is complete only through the earliest of the campaign links', async () => {
      await sql(
        `INSERT INTO external.campaign_link (id, campaign_id, source_id, credential_id, language, config)
         VALUES ($1, $2, 'zeus', '00000000-0000-4000-8000-000000000012', 'fr', '{}')`,
        [FR_LINK, CAMPAIGN],
      )
      await sql(
        `INSERT INTO external.sync_state (link_id, data_complete_through, last_synced_at)
         VALUES ($1, '2026-09-01', '2026-09-02T02:10:00Z')`,
        [FR_LINK],
      )

      const status = at(await call('get_source_status', 'zeus'))

      expect(status.data_complete_through).toBe('2026-09-01')
      expect(status.last_synced_at).toEqual(new Date('2026-09-04T02:10:00Z'))
    })

    it('answers for a campaign that has never synced', async () => {
      const status = at(await call('get_source_status', 'nexd', await emptyCampaign()))

      expect(status.data_complete_through).toBeNull()
      expect(status.last_synced_at).toBeNull()
    })
  })

  describe('app.build_webhook_payload', () => {
    async function build(
      options: { includeCheckSources?: boolean; includeCreatives?: boolean } = {},
    ): Promise<WebhookSourceBlock[]> {
      await sql(
        `INSERT INTO app.webhook
           (id, company_id, name, campaign_ids, url, secret, schedule_cron, next_run_at,
            include_check_sources, include_creatives)
         VALUES ($1, $2, 'weekly', ARRAY[$3::uuid], 'https://example.com/hook', 'unused',
                 '0 8 * * 1', now(), $4, $5)`,
        [
          WEBHOOK,
          SEED.companyId,
          CAMPAIGN,
          options.includeCheckSources ?? true,
          options.includeCreatives ?? true,
        ],
      )
      return at(webhookPayloadSchema.parse(await buildRaw(WEBHOOK)).campaigns).sources
    }

    async function buildRaw(webhookId: string): Promise<unknown> {
      const rows = await sql<{ payload: unknown }>(
        'SELECT app.build_webhook_payload($1, $2, $3) AS payload',
        [webhookId, FROM, TO],
      )
      return at(rows).payload
    }

    it('validates against the published contract', async () => {
      await build()
      const parsed = webhookPayloadSchema.parse(await buildRaw(WEBHOOK))

      expect(parsed.period).toEqual({
        start: FROM,
        end: TO,
        timezone: 'Europe/Zurich',
        window: 'previous_week',
      })
      expect(parsed.company).toEqual({ id: SEED.companyId, name: 'Dev Company' })
      expect(parsed.delivery_id).toBeNull() // stamped when the delivery row is created
    })

    it('puts the primary source first and labels the others as checks', async () => {
      const sources = await build()

      expect(sources.map((block) => [block.source, block.role])).toEqual([
        ['zeus', 'primary'],
        ['nexd', 'check'],
      ])
      // Each block keeps its own numbers; nothing adds them together.
      expect(at(sources).totals.impressions).toBe(600)
      expect(at(sources, 1).totals.impressions).toBe(3500)
    })

    it('omits check sources when the webhook does not want them', async () => {
      const sources = await build({ includeCheckSources: false })
      expect(sources.map((block) => block.source)).toEqual(['zeus'])
    })

    it('omits a metric the source does not measure', async () => {
      const sources = await build()
      const zeus = at(sources)
      const nexd = at(sources, 1)

      // Zeus reports no dwell and no interactions; NEXD has no finish pixel.
      expect(zeus.totals).not.toHaveProperty('dwell_avg_ms')
      expect(zeus.totals).not.toHaveProperty('interactions')
      expect(at(zeus.daily)).not.toHaveProperty('dwell_avg_ms')
      expect(nexd.totals).not.toHaveProperty('game_finished')
      expect(nexd.totals.dwell_avg_ms).toBe(1500)
    })

    it('keeps a measured metric as null rather than dropping or zeroing it', async () => {
      const zeus = at(await build())

      expect(zeus.totals.game_started).toBeNull()
      expect(zeus.totals.unique_clicks_reported).toBeNull()
    })

    it('merges the creatives of a day but passes a per-day scalar through only once', async () => {
      const nexd = at(await build(), 1)

      expect(nexd.daily.map((day) => [day.date, day.impressions])).toEqual([
        ['2026-09-01', 1500],
        ['2026-09-02', 2000],
      ])
      // 2026-09-01: two creatives reported unique impressions, so the day has no single value.
      expect(at(nexd.daily).unique_impressions_reported).toBeNull()
      expect(at(nexd.daily, 1).unique_impressions_reported).toBe(1200)
      // The day's dwell is weighted by its own game starts: (100·1000 + 100·500) / 200.
      expect(at(nexd.daily).dwell_avg_ms).toBe(750)
    })

    it('carries the pages and CTAs the source measures', async () => {
      const sources = await build()
      const zeus = at(sources)
      const nexd = at(sources, 1)

      expect(nexd.pages.map((page) => [page.name, page.count])).toEqual([
        ['Main', 1000],
        ['Result', 150],
      ])
      expect(nexd.ctas).toEqual([
        { cta_id: 'clickthrough', name: 'Click-out', is_internal_event: false, count: 30 },
      ])
      // Zeus has no view_counter in external.source_metric, so it reports no pages at all.
      expect(zeus.pages).toEqual([])
      expect(at(zeus.ctas).count).toBe(7)
    })

    it('drops the creative breakdown when the webhook does not want it', async () => {
      const sources = await build({ includeCreatives: false })
      expect(sources.every((block) => block.creatives.length === 0)).toBe(true)
    })

    it('names each creative when the webhook wants them', async () => {
      const nexd = at(await build(), 1)

      expect(nexd.creatives.map((creative) => [creative.campaign_tag, creative.label])).toEqual([
        ['nx_dev_v1', 'Dev creative V1'],
        ['nx_dev_v2', 'Dev creative V2'],
      ])
      expect(at(nexd.creatives).totals.impressions).toBe(3000)
    })

    it('reports a campaign with no data as empty, not as zero', async () => {
      const empty = await emptyCampaign()
      await sql(
        `INSERT INTO app.webhook (id, company_id, name, campaign_ids, url, secret, schedule_cron, next_run_at)
         VALUES ($1, $2, 'empty', ARRAY[$3::uuid], 'https://example.com/hook', 'unused', '0 8 * * 1', now())`,
        [EMPTY_WEBHOOK, SEED.companyId, empty],
      )

      const parsed = webhookPayloadSchema.parse(await buildRaw(EMPTY_WEBHOOK))
      const block = at(at(parsed.campaigns).sources)

      expect(block.source).toBe('nexd')
      expect(block.daily).toEqual([])
      expect(block.creatives).toEqual([])
      expect(block.totals.impressions).toBeNull()
      expect(block.data_complete_through).toBeNull()
    })

    it('rejects an unknown webhook', async () => {
      await expect(buildRaw('00000000-0000-4000-8000-00000000dead')).rejects.toThrow(
        /does not exist/,
      )
    })
  })
})
