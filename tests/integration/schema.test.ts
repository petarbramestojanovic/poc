import { describe, expect, it } from 'vitest'
import { SEED, sqlstateOf, useTransactionalClient } from './db.ts'

const UNIQUE_VIOLATION = '23505'
const FK_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'
const NOT_NULL_VIOLATION = '23502'

// Every table from RFC-004 with its primary key, in creation order.
const EXPECTED_TABLES: Record<string, string[]> = {
  'external.source': ['id'],
  'external.credential': ['id'],
  'app.company': ['id'],
  'app.campaign': ['id'],
  'app.webhook': ['id'],
  'app.webhook_delivery': ['id'],
  'analytics.metric': ['id'],
  'external.source_metric': ['source_id', 'metric_id'],
  'analytics.advanced_analytics': [
    'campaign_id',
    'source',
    'language',
    'campaign_tag',
    'events_date',
  ],
  'analytics.page': ['campaign_id', 'page_id'],
  'analytics.cta': ['campaign_id', 'cta_id'],
  'analytics.page_views': [
    'campaign_id',
    'source',
    'language',
    'campaign_tag',
    'page_id',
    'events_date',
  ],
  'analytics.cta_clicks': [
    'campaign_id',
    'source',
    'language',
    'campaign_tag',
    'cta_id',
    'events_date',
  ],
  'external.campaign_link': ['id'],
  'external.link_entity': ['link_id', 'level', 'external_id'],
  'external.event_map': ['link_id', 'event_name'],
  'external.unmapped_event': ['link_id', 'event_name'],
  'external.sync_state': ['link_id'],
  'external.sync_run': ['id'],
  'external.raw_payload': ['id'],
}

describe('migration 0001_foundation', () => {
  const { sql } = useTransactionalClient()

  it('creates every RFC-004 table with the expected primary key', async () => {
    const rows = await sql<{ table: string; pk: string[] }>(`
      SELECT n.nspname || '.' || c.relname AS "table",
             array_agg(a.attname::text ORDER BY k.ord) AS pk
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE con.contype = 'p' AND n.nspname IN ('app', 'analytics', 'external')
       GROUP BY 1
    `)
    const actual = Object.fromEntries(rows.map((r) => [r.table, r.pk]))
    expect(actual).toEqual(EXPECTED_TABLES)
  })

  it('seeds the source registry, the metric catalog and source_metric', async () => {
    const [sources] = await sql<{ ids: string[] }>(
      'SELECT array_agg(id ORDER BY id) AS ids FROM external.source',
    )
    expect(sources?.ids).toEqual(['brame', 'nexd', 'zeus'])

    const [metrics] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM analytics.metric')
    expect(metrics?.n).toBe('14')

    const perSource = await sql<{ source_id: string; n: string }>(
      'SELECT source_id, count(*)::text AS n FROM external.source_metric GROUP BY 1 ORDER BY 1',
    )
    expect(perSource).toEqual([
      { source_id: 'nexd', n: '9' },
      { source_id: 'zeus', n: '7' },
    ])
  })

  it('metric columns are nullable with no default: a keys-only insert stores NULLs', async () => {
    await sql(
      `INSERT INTO analytics.advanced_analytics (campaign_id, source, language, campaign_tag, events_date)
       VALUES ($1, 'zeus', 'de', 'mpu_v1', '2026-09-01')`,
      [SEED.campaignId],
    )
    const [row] = await sql<Record<string, unknown>>(
      `SELECT impressions, in_view, game_started, game_finished, interactions, hovered,
              in_view_time, dwell_time, interaction_time, dwell_avg_ms,
              unique_impressions_reported, unique_clicks_reported, data_source
         FROM analytics.advanced_analytics
        WHERE campaign_id = $1 AND source = 'zeus' AND events_date = '2026-09-01'`,
      [SEED.campaignId],
    )
    expect(row).toEqual({
      impressions: null,
      in_view: null,
      game_started: null,
      game_finished: null,
      interactions: null,
      hovered: null,
      in_view_time: null,
      dwell_time: null,
      interaction_time: null,
      dwell_avg_ms: null,
      unique_impressions_reported: null,
      unique_clicks_reported: null,
      data_source: 'live',
    })
  })

  it('rejects a duplicate natural key', async () => {
    const insert = () =>
      sql(
        `INSERT INTO analytics.advanced_analytics (campaign_id, source, language, campaign_tag, events_date, impressions)
         VALUES ($1, 'nexd', 'de', 'nx_dev_v1', '2026-09-02', 10)`,
        [SEED.campaignId],
      )
    await insert()
    expect(await sqlstateOf(insert)).toBe(UNIQUE_VIOLATION)
  })

  it('rejects an unknown source', async () => {
    const code = await sqlstateOf(() =>
      sql(
        `INSERT INTO analytics.advanced_analytics (campaign_id, source, events_date)
         VALUES ($1, 'foo', '2026-09-01')`,
        [SEED.campaignId],
      ),
    )
    expect(code).toBe(FK_VIOLATION)
  })

  it('page_views and cta_clicks require a definition row', async () => {
    const pageCode = await sqlstateOf(() =>
      sql(
        `INSERT INTO analytics.page_views (campaign_id, source, page_id, events_date, view_counter)
         VALUES ($1, 'nexd', 'no-such-page', '2026-09-01', 1)`,
        [SEED.campaignId],
      ),
    )
    expect(pageCode).toBe(FK_VIOLATION)

    const ctaCode = await sqlstateOf(() =>
      sql(
        `INSERT INTO analytics.cta_clicks (campaign_id, source, cta_id, events_date, cta_counter)
         VALUES ($1, 'nexd', 'no-such-cta', '2026-09-01', 1)`,
        [SEED.campaignId],
      ),
    )
    expect(ctaCode).toBe(FK_VIOLATION)
  })

  it('an external entity belongs to one campaign only', async () => {
    const code = await sqlstateOf(() =>
      sql(
        `INSERT INTO external.link_entity (link_id, source_id, level, external_id)
         VALUES ($1, 'nexd', 'creative', 'nx_dev_v1')`,
        [SEED.zeusLinkId],
      ),
    )
    expect(code).toBe(UNIQUE_VIOLATION)
  })

  it('webhook urls must be https', async () => {
    const code = await sqlstateOf(() =>
      sql(
        `INSERT INTO app.webhook (company_id, name, url, secret, schedule_cron, next_run_at)
         VALUES ($1, 'x', 'http://example.com/hook', 's', '0 8 * * 1', now())`,
        [SEED.companyId],
      ),
    )
    expect(code).toBe(CHECK_VIOLATION)
  })
})

describe('external.event_map target validation trigger', () => {
  const { sql } = useTransactionalClient()

  const insert = (eventName: string, kind: string, targetId: string | null) =>
    sql(
      `INSERT INTO external.event_map (link_id, event_name, target_kind, target_id) VALUES ($1, $2, $3, $4)`,
      [SEED.nexdLinkId, eventName, kind, targetId],
    )

  it('accepts valid metric, page_view, cta_click and ignore targets', async () => {
    await insert('e1', 'metric', 'game_finished')
    await insert('e2', 'page_view', 'result')
    await insert('e3', 'cta_click', 'clickthrough')
    await insert('e4', 'ignore', null)
  })

  it('rejects a metric that is not an advanced_analytics column', async () => {
    expect(await sqlstateOf(() => insert('e', 'metric', 'view_counter'))).toBe(FK_VIOLATION)
    expect(await sqlstateOf(() => insert('e', 'metric', 'nope'))).toBe(FK_VIOLATION)
  })

  it("rejects a page or cta that does not exist for the link's campaign", async () => {
    expect(await sqlstateOf(() => insert('e', 'page_view', 'nope'))).toBe(FK_VIOLATION)
    expect(await sqlstateOf(() => insert('e', 'cta_click', 'nope'))).toBe(FK_VIOLATION)
  })

  it('rejects a missing target_id unless the kind is ignore', async () => {
    expect(await sqlstateOf(() => insert('e', 'page_view', null))).toBe(NOT_NULL_VIOLATION)
  })

  it('rejects a target_id on an ignore mapping', async () => {
    expect(await sqlstateOf(() => insert('e', 'ignore', 'main'))).toBe(CHECK_VIOLATION)
  })
})
