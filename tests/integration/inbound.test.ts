import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { createDb, type Db } from '../../src/db.ts'
import { createLogger } from '../../src/log.ts'
import type { IngestSummary } from '../../src/salesforce/ingest.ts'
import { createDefaultRegistry } from '../../src/sync/connectors/index.ts'
import { at } from '../helpers.ts'

// The daily Salesforce report through POST /inbound/campaigns into the real schema, morning after
// morning. Accounts are named 'IT Inbound …' (company ids 'it_inbound_…') and opportunity ids start
// with '006ITINBOUND'; no other test file writes either.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const INBOUND = 'it-inbound-token-long-enough-0123456789-abcdef'

const config: Config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: ADMIN,
  inboundCampaignsToken: INBOUND,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
}

const row = (n: number, over: Record<string, unknown> = {}) => ({
  opportunity_owner: 'Erika Beispiel',
  opportunity_name: `AT2610 IT Inbound Campaign ${n}`,
  opportunity_id: `006ITINBOUND00${n}`,
  account_name: 'IT Inbound Agency GmbH',
  currency: 'EUR',
  amount: 10000,
  billing_country: 'Austria',
  campaign_start_date: '2026-10-12',
  campaign_end_date: '2026-11-30',
  creative_languages: 'German',
  nn_price: 13.0682,
  billing_type: 'CPM',
  targeting: 'A18-55',
  whitelisted: null,
  blacklisted: null,
  deliverables: 1000000,
  campaign_manager: 'Max Muster',
  ...over,
})

const report = (campaigns: unknown[], over: Record<string, unknown> = {}) => ({
  source: 'salesforce_report',
  report_name: 'Media Solutions - Committed Opps - Daily',
  report_as_of: '2026-10-06T06:00:03',
  report_timezone: 'Europe/Zurich',
  snapshot: true,
  record_count: campaigns.length,
  unmapped_columns: [],
  campaigns,
  ...over,
})

/** The first morning: two campaigns of one agency, one direct advertiser on CPC. */
const morning = () =>
  report([
    row(1),
    row(2, { creative_languages: 'German; French', nn_price: 21.5, currency: 'CHF' }),
    row(3, {
      account_name: 'IT Inbound Roastery GmbH',
      opportunity_name: 'DE2610 IT Inbound Roastery',
      billing_type: 'CPC',
      nn_price: 0.5,
    }),
  ])

interface StoredCampaign {
  name: string
  company: string
  company_ref: string
  starts_on: string
  ends_on: string
  languages: string[]
  price: string | null
  currency: string | null
  primary_source: string
  status: string
  timezone: string
  links: number
  updated_at: Date
}

describe('POST /inbound/campaigns', () => {
  let db: Db
  let app: FastifyInstance

  const cleanup = async () => {
    await db.query(`DELETE FROM app.campaign WHERE external_id LIKE '006ITINBOUND%'`)
    await db.query(`DELETE FROM app.company WHERE external_id LIKE 'it_inbound_%'`)
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    // app.close() closes the pool it was given, so the app gets its own.
    const appDb = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    const log = createLogger('silent')
    app = buildApp({
      config,
      db: appDb,
      logger: log,
      campaigns: { db: appDb, registry: createDefaultRegistry(), log },
    })
    await cleanup()
  })
  afterEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await app.close()
    await db.close()
  })

  const push = async (payload: unknown, token = INBOUND) =>
    app.inject({
      method: 'POST',
      url: '/inbound/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    })

  const pushed = async (payload: unknown): Promise<IngestSummary> => {
    const res = await push(payload)
    expect(res.statusCode).toBe(200)
    return res.json<IngestSummary>()
  }

  /** By opportunity id, read back by column name. */
  const stored = async (): Promise<Record<string, StoredCampaign>> => {
    const rows = await db.query<StoredCampaign & { opportunity_id: string }>(
      `SELECT c.external_id AS opportunity_id, c.name, co.name AS company, co.external_id AS company_ref,
              c.starts_on, c.ends_on, c.languages, c.price::text AS price, c.currency,
              c.primary_source, c.status, c.timezone, c.updated_at,
              (SELECT count(*)::int FROM external.campaign_link l WHERE l.campaign_id = c.id) AS links
         FROM app.campaign c JOIN app.company co ON co.id = c.company_id
        WHERE c.external_system = 'salesforce' AND c.external_id LIKE '006ITINBOUND%'`,
    )
    return Object.fromEntries(
      rows.map(({ opportunity_id, ...campaign }) => [opportunity_id, campaign]),
    )
  }

  it('sets up every campaign of the report under its account', async () => {
    const summary = await pushed(morning())

    expect(summary).toMatchObject({
      report: { name: 'Media Solutions - Committed Opps - Daily', asOf: '2026-10-06T06:00:03' },
      received: 3,
      created: 3,
      updated: 0,
      unchanged: 0,
      rejected: [],
      warnings: [],
    })
    const campaigns = await stored()
    expect(campaigns['006ITINBOUND001']).toMatchObject({
      name: 'AT2610 IT Inbound Campaign 1',
      company: 'IT Inbound Agency GmbH',
      company_ref: 'it_inbound_agency_gmbh',
      starts_on: '2026-10-12',
      ends_on: '2026-11-30',
      languages: ['de'],
      price: '13.0682',
      currency: 'EUR',
      primary_source: 'zeus',
      status: 'active',
      timezone: 'Europe/Zurich',
      links: 0,
    })
    expect(campaigns['006ITINBOUND002']).toMatchObject({
      company_ref: 'it_inbound_agency_gmbh',
      languages: ['de', 'fr'],
      price: '21.5000',
      currency: 'CHF',
    })
    // Always a CPM, whatever the billing type says.
    expect(campaigns['006ITINBOUND003']).toMatchObject({
      company: 'IT Inbound Roastery GmbH',
      company_ref: 'it_inbound_roastery_gmbh',
      price: '0.5000',
    })
    // One company per account, however many campaigns it has.
    const companies = await db.query(
      `SELECT external_id FROM app.company WHERE external_id LIKE 'it_inbound_%' ORDER BY 1`,
    )
    expect(companies).toEqual([
      { external_id: 'it_inbound_agency_gmbh' },
      { external_id: 'it_inbound_roastery_gmbh' },
    ])
  })

  it('changes nothing when the same report comes again', async () => {
    await pushed(morning())
    const before = await stored()

    const again = await pushed(morning())

    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3, rejected: [] })
    const after = await stored()
    expect(at(Object.values(after)).updated_at).toEqual(at(Object.values(before)).updated_at)
    expect(after).toEqual(before)
  })

  it("applies the next morning's changes and leaves alone a campaign that dropped out", async () => {
    await pushed(morning())

    const next = await pushed(
      report(
        [
          row(1, {
            opportunity_name: 'AT2610 IT Inbound Campaign 1 Extended',
            campaign_end_date: '2026-12-15',
            nn_price: 12.9,
          }),
          // Campaign 2 has started, so the report no longer carries it.
          morning().campaigns[2],
        ],
        { report_as_of: '2026-10-07T06:00:03' },
      ),
    )

    expect(next).toMatchObject({ received: 2, created: 0, updated: 1, unchanged: 1 })
    const campaigns = await stored()
    expect(campaigns['006ITINBOUND001']).toMatchObject({
      name: 'AT2610 IT Inbound Campaign 1 Extended',
      ends_on: '2026-12-15',
      price: '12.9000',
    })
    expect(campaigns['006ITINBOUND002']).toMatchObject({ status: 'active', price: '21.5000' })
  })

  it('skips the rows it cannot take, says why, and sets up the rest', async () => {
    await pushed(morning())

    const next = await pushed(
      report(
        [
          // The opportunity moved to another account: a campaign never changes company.
          row(1, { account_name: 'IT Inbound Other Agency GmbH' }),
          row(9, { opportunity_id: '006-not-an-id' }),
          row(4, { creative_languages: 'German; Klingon' }),
        ],
        { unmapped_columns: ['Brand'] },
      ),
    )

    expect(next).toMatchObject({ received: 3, created: 1, updated: 0, unchanged: 0 })
    expect(next.rejected).toEqual([
      expect.objectContaining({
        row: 0,
        opportunityId: '006ITINBOUND001',
        error: 'company_mismatch',
      }),
      expect.objectContaining({ row: 1, opportunityId: null, error: 'invalid_row' }),
    ])
    expect(next.warnings.map((warning) => [warning.row, warning.opportunityId])).toEqual([
      [null, null],
      [2, '006ITINBOUND004'],
    ])
    expect(at(next.warnings).message).toContain('Brand')
    expect(at(next.warnings, 1).message).toContain('Klingon')
    const campaigns = await stored()
    expect(campaigns['006ITINBOUND001']?.company).toBe('IT Inbound Agency GmbH')
    expect(campaigns['006ITINBOUND004']?.languages).toEqual(['de'])
    // The refused row created no company either.
    expect(
      await db.query(
        `SELECT 1 FROM app.company WHERE external_id = 'it_inbound_other_agency_gmbh'`,
      ),
    ).toEqual([])
  })

  it('keeps the platform ids a person added when the report comes again', async () => {
    await pushed(morning())
    const [campaign] = await db.query<{ id: string }>(
      `SELECT id FROM app.campaign WHERE external_id = '006ITINBOUND001'`,
    )
    const ids = await app.inject({
      method: 'PUT',
      url: `/campaigns/${campaign?.id ?? ''}/platforms/nexd`,
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { creatives: [{ liveId: 'it-inbound-nx-1' }] },
    })
    expect(ids.statusCode).toBe(200)

    const again = await pushed(morning())

    expect(again).toMatchObject({ unchanged: 3 })
    expect((await stored())['006ITINBOUND001']).toMatchObject({ links: 1, primary_source: 'nexd' })
  })

  it('reads a report larger than the 64 KiB admin limit, and stores none of the extra fields', async () => {
    const long = 'targeting '.repeat(3_000)
    const big = report([1, 2, 3].map((n) => row(n, { targeting: long })))
    expect(JSON.stringify(big).length).toBeGreaterThan(64 * 1024)

    expect(await pushed(big)).toMatchObject({ created: 3, rejected: [] })
    const [hit] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.campaign c WHERE c.external_id LIKE '006ITINBOUND%'
          AND (row_to_json(c)::text LIKE '%targeting%' OR row_to_json(c)::text LIKE '%Erika%')`,
    )
    expect(hit?.n).toBe(0)
  })

  it('refuses the admin token', async () => {
    const res = await push(morning(), ADMIN)
    expect(res.statusCode).toBe(401)
    expect(await stored()).toEqual({})
  })
})
