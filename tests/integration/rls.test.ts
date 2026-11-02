import { describe, expect, it } from 'vitest'
import { SEED, sqlstateOf, useTransactionalClient } from './db.ts'

// Who may read what once RLS is on (migration 0006). The service owns these tables and bypasses
// RLS; the console signs in and reads as `authenticated`; the anon key alone reads nothing. Each
// case is one row of that table, asserted through the roles themselves rather than through grants.

const DENIED = '42501' // insufficient_privilege

// What a logged-in reader may see of app.campaign since 0010: of what the deal says, the manager.
const READABLE_CAMPAIGN_COLUMNS = [
  'company_id',
  'created_at',
  'currency',
  'ends_on',
  'external_id',
  'external_system',
  'id',
  'languages',
  'legacy_campaign_id',
  'manager_external_id',
  'manager_name',
  'name',
  'price',
  'primary_source',
  'starts_on',
  'status',
  'timezone',
  'updated_at',
]

describe('RLS and the reader grants', () => {
  const { sql } = useTransactionalClient()

  const asAuthenticated = () => sql('SET LOCAL ROLE authenticated')
  const asAnon = () => sql('SET LOCAL ROLE anon')

  it('covers every table in app, analytics and external', async () => {
    const [row] = await sql<{ unprotected: string[] }>(
      `SELECT coalesce(array_agg(n.nspname || '.' || c.relname ORDER BY 1), '{}') AS unprotected
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('app', 'analytics', 'external')
          AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    )
    expect(row?.unprotected).toEqual([])
  })

  describe('a logged-in reader', () => {
    it.each([
      'analytics.advanced_analytics',
      'analytics.cta_clicks',
      'analytics.page_views',
      'analytics.cta',
      'analytics.page',
      'analytics.metric',
      'external.source',
      'external.campaign_link',
      'external.link_entity',
      'external.event_map',
      'external.sync_run',
      'external.sync_state',
      'external.unmapped_event',
      'app.campaign',
    ])('reads %s', async (table) => {
      await asAuthenticated()
      expect(await sqlstateOf(() => sql(`SELECT count(*) FROM ${table}`))).toBeUndefined()
    })

    it.each([
      ['external.credential', 'points at the secret env vars'],
      ['external.raw_payload', 'whole vendor responses'],
      ['app.company', 'not needed: company names come from the admin API'],
      ['app.webhook', 'holds the signing secret'],
      ['app.webhook_delivery', 'holds every payload we sent'],
    ])('never reads %s (%s)', async (table) => {
      await asAuthenticated()
      expect(await sqlstateOf(() => sql(`SELECT count(*) FROM ${table}`))).toBe(DENIED)
    })

    it('reads exactly these columns of app.campaign, so a new column starts closed', async () => {
      const rows = await sql<{ column_name: string; readable: boolean }>(
        `SELECT column_name, has_column_privilege('authenticated', 'app.campaign', column_name, 'SELECT') AS readable
           FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'campaign'`,
      )
      const readable = rows.filter((row) => row.readable).map((row) => row.column_name)
      expect(readable.sort()).toEqual(READABLE_CAMPAIGN_COLUMNS)
    })

    it.each(READABLE_CAMPAIGN_COLUMNS)('reads app.campaign.%s', async (column) => {
      await asAuthenticated()
      expect(await sqlstateOf(() => sql(`SELECT ${column} FROM app.campaign`))).toBeUndefined()
    })

    it.each([
      'amount',
      'amount_currency',
      'deal_type',
      'country',
      'creative_types',
      'owner_name',
      'external_modified_at',
    ])(
      'never reads app.campaign.%s: the deal stays closed, but for its manager',
      async (column) => {
        await asAuthenticated()
        expect(await sqlstateOf(() => sql(`SELECT ${column} FROM app.campaign`))).toBe(DENIED)
      },
    )

    it('cannot get at them with SELECT * either', async () => {
      await asAuthenticated()
      expect(await sqlstateOf(() => sql('SELECT * FROM app.campaign'))).toBe(DENIED)
    })

    it('calls the analytics read functions, but not the payload builders', async () => {
      await asAuthenticated()
      expect(
        await sqlstateOf(() =>
          sql('SELECT * FROM analytics.get_engagement_totals($1, $2, $3, NULL)', [
            SEED.campaignId,
            '2026-09-01',
            '2026-09-30',
          ]),
        ),
      ).toBeUndefined()
      expect(
        await sqlstateOf(() =>
          sql('SELECT app.build_webhook_payload($1, $2, $3)', [
            SEED.campaignId,
            '2026-09-01',
            '2026-09-30',
          ]),
        ),
      ).toBe(DENIED)
    })

    it('reads only: it cannot write, even where it can read', async () => {
      await asAuthenticated()
      const write = (statement: string) => sqlstateOf(() => sql(statement))
      expect(
        await write(
          `INSERT INTO analytics.advanced_analytics
             (campaign_id, source, language, campaign_tag, events_date, impressions, data_source)
           VALUES ('${SEED.campaignId}', 'zeus', 'de', 'x', '2026-09-01', 1, 'sync')`,
        ),
      ).toBe(DENIED)
      expect(await write(`DELETE FROM external.sync_run`)).toBe(DENIED)
      expect(await write(`UPDATE app.campaign SET name = 'hijacked'`)).toBe(DENIED)
    })
  })

  describe('the browser key before a login', () => {
    it.each(['analytics.advanced_analytics', 'external.sync_run', 'app.campaign'])(
      'reads nothing from %s',
      async (table) => {
        await asAnon()
        expect(await sqlstateOf(() => sql(`SELECT count(*) FROM ${table}`))).toBe(DENIED)
      },
    )

    it('cannot call the read functions either', async () => {
      await asAnon()
      expect(
        await sqlstateOf(() =>
          sql('SELECT * FROM analytics.get_engagement_totals($1, $2, $3, NULL)', [
            SEED.campaignId,
            '2026-09-01',
            '2026-09-30',
          ]),
        ),
      ).toBe(DENIED)
    })
  })

  it('leaves the service itself untouched: it owns the tables and bypasses RLS', async () => {
    const [credentials] = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM external.credential',
    )
    const [campaigns] = await sql<{ n: number }>('SELECT count(*)::int AS n FROM app.campaign')
    expect(credentials?.n).toBeGreaterThan(0)
    expect(campaigns?.n).toBeGreaterThan(0)
  })
})
