import { describe, expect, it } from 'vitest'
import { at } from '../helpers.ts'
import { SEED, sqlstateOf, useTransactionalClient } from './db.ts'

const UNIQUE_VIOLATION = '23505'
const FK_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'
const NOT_NULL_VIOLATION = '23502'

// Every table from RFC-004 with its primary key, in creation order, plus the two of 0011.
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
  'app.creative': ['id'],
  'external.provisioned_resource': ['id'],
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
       VALUES ($1, 'zeus', 'de', 'schema_probe', '2031-01-01')`,
      [SEED.campaignId],
    )
    const [row] = await sql<Record<string, unknown>>(
      `SELECT impressions, in_view, game_started, game_finished, interactions, hovered,
              in_view_time, dwell_time, interaction_time, dwell_avg_ms,
              unique_impressions_reported, unique_clicks_reported, data_source
         FROM analytics.advanced_analytics
        WHERE campaign_id = $1 AND source = 'zeus' AND campaign_tag = 'schema_probe' AND events_date = '2031-01-01'`,
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

  it.each<[string, string]>([
    ['an amount without a currency', 'amount = 100'],
    ['a currency without an amount', `amount_currency = 'EUR'`],
    ['a manager name without an id', `manager_name = 'Max'`],
    ['a negative amount', `amount = -1, amount_currency = 'EUR'`],
    ['a currency that is no code', `amount = 1, amount_currency = 'euro'`],
  ])('a campaign cannot hold %s', async (_name, change) => {
    const code = await sqlstateOf(() =>
      sql(`UPDATE app.campaign SET ${change} WHERE id = $1`, [SEED.campaignId]),
    )
    expect(code).toBe(CHECK_VIOLATION)
  })

  it('a campaign whose deal nobody has described has no creative types, not NULL', async () => {
    const [row] = await sql<{ creative_types: string[] }>(
      'SELECT creative_types FROM app.campaign WHERE id = $1',
      [SEED.campaignId],
    )
    expect(row?.creative_types).toEqual([])
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
    await expect(insert('e1', 'metric', 'game_finished')).resolves.toBeDefined()
    await expect(insert('e2', 'page_view', 'result')).resolves.toBeDefined()
    await expect(insert('e3', 'cta_click', 'clickthrough')).resolves.toBeDefined()
    await expect(insert('e4', 'ignore', null)).resolves.toBeDefined()
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

describe('migration 0011_creative', () => {
  const { sql } = useTransactionalClient()

  // The seed's creatives, keyed by hand like every creative that existed before 0011.
  const MPU_V1 = '00000000-0000-4000-8000-000000000033'

  const entity = (over: {
    link?: string
    level?: string
    externalId: string
    tag: string
    creative: string | null
  }) =>
    sqlstateOf(() =>
      sql(
        `INSERT INTO external.link_entity (link_id, source_id, level, external_id, campaign_tag, creative_id)
         VALUES ($1, 'zeus', $2, $3, $4, $5)`,
        [
          over.link ?? SEED.zeusLinkId,
          over.level ?? 'pixel',
          over.externalId,
          over.tag,
          over.creative,
        ],
      ),
    )

  it('backfilled a creative for every tag the seed stamps, pointed at by its ids and its pixel', async () => {
    const creatives = await sql<{ tag: string; name: string; entities: number }>(
      `SELECT c.tag, c.name, (SELECT count(*)::int FROM external.link_entity e WHERE e.creative_id = c.id) AS entities
         FROM app.creative c WHERE c.campaign_id = $1 ORDER BY c.tag`,
      [SEED.campaignId],
    )
    expect(creatives).toEqual([
      { tag: 'mpu_v1', name: 'Dev MPU V1', entities: 2 }, // the Zeus creative and its pixel
      { tag: 'nx_dev_v1', name: 'Dev creative V1', entities: 1 },
      { tag: 'nx_dev_v2', name: 'Dev creative V2', entities: 1 },
    ])
  })

  it('a creative created from now on is tagged with its own id', async () => {
    const [row] = await sql<{ tag_is_id: boolean }>(
      `WITH minted AS (SELECT gen_random_uuid() AS id)
       INSERT INTO app.creative (id, campaign_id, tag, name)
       SELECT id, $1, id::text, 'New' FROM minted RETURNING tag = id::text AS tag_is_id`,
      [SEED.campaignId],
    )
    expect(row?.tag_is_id).toBe(true)
  })

  it('never lets a tag change: every analytics row of the creative carries it', async () => {
    expect(
      await sqlstateOf(() =>
        sql(`UPDATE app.creative SET tag = 'renamed' WHERE id = $1`, [MPU_V1]),
      ),
    ).toBe(CHECK_VIOLATION)
    // The name may change at any time.
    expect(
      await sqlstateOf(() =>
        sql(`UPDATE app.creative SET name = 'Dev MPU' WHERE id = $1`, [MPU_V1]),
      ),
    ).toBeUndefined()
  })

  it('wants a tag, a name and a type that are not blank, and one creative per tag', async () => {
    const insert = (columns: string) =>
      sqlstateOf(() =>
        sql(`INSERT INTO app.creative (campaign_id, tag, name, type) VALUES ($1, ${columns})`, [
          SEED.campaignId,
        ]),
      )
    expect(await insert(`'', 'x', NULL`)).toBe(CHECK_VIOLATION)
    expect(await insert(`'t', '', NULL`)).toBe(CHECK_VIOLATION)
    expect(await insert(`'t', 'x', ''`)).toBe(CHECK_VIOLATION)
    expect(await insert(`'mpu_v1', 'again', NULL`)).toBe(UNIQUE_VIOLATION)
  })

  describe('an entity with a tag names a creative of its campaign', () => {
    it('accepts a pixel that counts for a creative, and one on the campaign row', async () => {
      expect(
        await entity({ externalId: 'pix-ok', tag: 'mpu_v1', creative: MPU_V1 }),
      ).toBeUndefined()
      expect(await entity({ externalId: 'pix-row', tag: '', creative: null })).toBeUndefined()
    })

    it('rejects a tag without a creative', async () => {
      expect(await entity({ externalId: 'pix-1', tag: 'mpu_v1', creative: null })).toBe(
        CHECK_VIOLATION,
      )
    })

    it("rejects a creative whose tag is not the entity's", async () => {
      expect(await entity({ externalId: 'pix-2', tag: 'nx_dev_v1', creative: MPU_V1 })).toBe(
        CHECK_VIOLATION,
      )
    })

    it('rejects a creative on the campaign row', async () => {
      expect(await entity({ externalId: 'pix-3', tag: '', creative: MPU_V1 })).toBe(CHECK_VIOLATION)
    })

    it("rejects another campaign's creative", async () => {
      const other = at(
        await sql<{ id: string; link: string }>(
          `WITH co AS (INSERT INTO app.company (name) VALUES ('Schema Other Co') RETURNING id),
              ca AS (INSERT INTO app.campaign (company_id, name, primary_source)
                     SELECT id, 'Schema Other', 'zeus' FROM co RETURNING id),
              cr AS (INSERT INTO app.creative (campaign_id, tag, name)
                     SELECT id, 'other_tag', 'Other' FROM ca RETURNING id),
              li AS (INSERT INTO external.campaign_link (campaign_id, source_id, credential_id, language)
                     SELECT id, 'zeus', '00000000-0000-4000-8000-000000000012', '' FROM ca RETURNING id)
         SELECT cr.id, li.id AS link FROM cr, li`,
        ),
      )
      // The seed's link, the other campaign's creative, under its own tag: still refused.
      expect(await entity({ externalId: 'pix-4', tag: 'other_tag', creative: other.id })).toBe(
        CHECK_VIOLATION,
      )
      // On its own campaign's link it is fine.
      expect(
        await entity({
          link: other.link,
          externalId: 'pix-5',
          tag: 'other_tag',
          creative: other.id,
        }),
      ).toBeUndefined()
    })
  })

  it('a creative with entities cannot be deleted; its campaign going takes it along', async () => {
    expect(await sqlstateOf(() => sql(`DELETE FROM app.creative WHERE id = $1`, [MPU_V1]))).toBe(
      FK_VIOLATION,
    )
  })

  it('provisioned_resource keys a platform thing once and needs a source it knows', async () => {
    const insert = (source: string, kind: string, externalId: string) =>
      sqlstateOf(() =>
        sql(
          `INSERT INTO external.provisioned_resource (source_id, campaign_id, kind, external_id)
           VALUES ($1, $2, $3, $4)`,
          [source, SEED.campaignId, kind, externalId],
        ),
      )
    expect(await insert('nexd', 'campaign', 'coYV5VGFPODsDnKi')).toBeUndefined()
    expect(await insert('nexd', 'campaign', 'coYV5VGFPODsDnKi')).toBe(UNIQUE_VIOLATION)
    expect(await insert('nexd', 'creative', 'coYV5VGFPODsDnKi')).toBeUndefined() // another kind
    expect(await insert('nope', 'campaign', 'x')).toBe(FK_VIOLATION)
    expect(await insert('nexd', '', 'x')).toBe(CHECK_VIOLATION)
  })
})
