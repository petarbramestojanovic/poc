import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import { createLogger } from '../../src/core/log.ts'
import type { IngestSummary } from '../../src/modules/salesforce/ingest.ts'
import { createDefaultRegistry } from '../../src/modules/sync/connectors/index.ts'
import { at } from '../helpers.ts'

// Salesforce's Opportunity webhook through POST /inbound/salesforce/opportunities into the real
// schema, delivery after delivery. Opportunity ids start with '006ITINBOUND' and account ids with
// '001ITINBOUND'; no other test file writes either.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const INBOUND = 'it-inbound-token-long-enough-0123456789-abcdef'
const URL = '/inbound/salesforce/opportunities'

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

const AGENCY = '001ITINBOUNDAGENCY'
const ROASTERY = '001ITINBOUNDROASTR'
const OTHER = '001ITINBOUNDOTHERA'
const NAMESAKE_A = '001ITINBOUNDNAMEAA'
const NAMESAKE_B = '001ITINBOUNDNAMEBB'

/** An 18-character opportunity id: '006ITINBOUND000001'. */
const opp = (n: number) => `006ITINBOUND${String(n).padStart(6, '0')}`

const record = (n: number, over: Record<string, unknown> = {}) => ({
  attributes: { type: 'Opportunity', url: `/services/data/v66.0/sobjects/Opportunity/${opp(n)}` },
  Id: opp(n),
  AccountId: AGENCY,
  Name: `AT2610 IT Inbound Campaign ${n}`,
  Amount: 13068.2,
  Type: 'Media Solutions',
  CurrencyIsoCode: 'EUR',
  LastModifiedDate: '2026-10-11T22:00:16.000+0000',
  Owner_Name__c: 'Erika Beispiel',
  Account_Name__c: 'IT Inbound Agency GmbH',
  N_N_Price__c: 13.0682,
  Campaign_Start_Date__c: '2026-10-12',
  Campaign_End_Date__c: '2026-11-30',
  Country__c: 'Austria',
  Creative_Type__c: 'Reveal Ad',
  ...over,
})

/** The first delivery: two campaigns of one agency, one direct advertiser on another currency. */
const first = () => [
  record(1, { Creative_Languages__c: 'German' }),
  // Five decimals, as Salesforce sells some prices.
  record(2, { N_N_Price__c: 0.39525 }),
  record(3, {
    AccountId: ROASTERY,
    Account_Name__c: 'IT Inbound Roastery GmbH',
    Name: 'DE2610 IT Inbound Roastery',
    N_N_Price__c: 21.5,
    CurrencyIsoCode: 'CHF',
  }),
]

interface StoredCampaign {
  name: string
  company_id: string
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

describe('POST /inbound/salesforce/opportunities', () => {
  let db: Db
  let app: FastifyInstance
  const log = createLogger('silent')

  const cleanup = async () => {
    await db.query(`DELETE FROM app.campaign WHERE external_id LIKE '006ITINBOUND%'`)
    await db.query(`DELETE FROM app.company WHERE external_id LIKE '001ITINBOUND%'`)
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    // app.close() closes the pool it was given, so the app gets its own.
    const appDb = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
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
      url: URL,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })

  const pushed = async (payload: unknown): Promise<IngestSummary> => {
    const res = await push(payload)
    expect(res.statusCode).toBe(200)
    return res.json<IngestSummary>()
  }

  /** By opportunity id, read back by column name. */
  const stored = async (): Promise<Record<string, StoredCampaign>> => {
    const rows = await db.query<StoredCampaign & { opportunity_id: string }>(
      `SELECT c.external_id AS opportunity_id, c.name, co.id AS company_id, co.name AS company,
              co.external_id AS company_ref, c.starts_on, c.ends_on, c.languages,
              c.price::text AS price, c.currency, c.primary_source, c.status, c.timezone,
              c.updated_at,
              (SELECT count(*)::int FROM external.campaign_link l WHERE l.campaign_id = c.id) AS links
         FROM app.campaign c JOIN app.company co ON co.id = c.company_id
        WHERE c.external_system = 'salesforce' AND c.external_id LIKE '006ITINBOUND%'`,
    )
    return Object.fromEntries(
      rows.map(({ opportunity_id, ...campaign }) => [opportunity_id, campaign]),
    )
  }

  const companies = async () =>
    db.query<{ id: string; name: string; external_id: string }>(
      `SELECT id, name, external_id FROM app.company
        WHERE external_id LIKE '001ITINBOUND%' ORDER BY external_id`,
    )

  it('sets up every campaign of the delivery under its account', async () => {
    const summary = await pushed(first())

    expect(summary).toEqual({
      received: 3,
      created: 3,
      updated: 0,
      unchanged: 0,
      skipped: [],
      rejected: [],
      warnings: [],
    })
    const campaigns = await stored()
    expect(campaigns[opp(1)]).toMatchObject({
      name: 'AT2610 IT Inbound Campaign 1',
      company: 'IT Inbound Agency GmbH',
      company_ref: AGENCY,
      starts_on: '2026-10-12',
      ends_on: '2026-11-30',
      languages: ['de'],
      price: '13.068200',
      currency: 'EUR',
      primary_source: 'zeus',
      status: 'active',
      timezone: 'Europe/Zurich',
      links: 0,
    })
    // The webhook does not promise the languages: without them, the campaign has none.
    expect(campaigns[opp(2)]).toMatchObject({
      company_ref: AGENCY,
      languages: [],
      price: '0.395250',
    })
    expect(campaigns[opp(3)]).toMatchObject({
      company: 'IT Inbound Roastery GmbH',
      company_ref: ROASTERY,
      price: '21.500000',
      currency: 'CHF',
    })
    // One company per account, however many campaigns it has.
    expect((await companies()).map((company) => company.external_id)).toEqual([AGENCY, ROASTERY])
  })

  it('takes a single record as well as a list', async () => {
    expect(await pushed(record(4))).toMatchObject({ received: 1, created: 1 })
    expect((await stored())[opp(4)]).toMatchObject({ company_ref: AGENCY })
  })

  it('changes nothing when the same records come again', async () => {
    await pushed(first())
    const before = await stored()

    const again = await pushed(first())

    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3, rejected: [] })
    const after = await stored()
    expect(at(Object.values(after)).updated_at).toEqual(at(Object.values(before)).updated_at)
    expect(after).toEqual(before)
  })

  it('applies a changed opportunity and keeps the company of a renamed account', async () => {
    await pushed(first())
    const before = await stored()

    const next = await pushed([
      record(1, {
        Name: 'AT2610 IT Inbound Campaign 1 Extended',
        Campaign_End_Date__c: '2026-12-15',
        N_N_Price__c: 12.9,
        Account_Name__c: 'IT Inbound Agency Austria GmbH',
      }),
    ])

    expect(next).toMatchObject({ received: 1, created: 0, updated: 1, unchanged: 0 })
    const campaigns = await stored()
    expect(campaigns[opp(1)]).toMatchObject({
      name: 'AT2610 IT Inbound Campaign 1 Extended',
      ends_on: '2026-12-15',
      price: '12.900000',
      company_id: before[opp(1)]?.company_id,
      company: 'IT Inbound Agency Austria GmbH',
    })
    // The account is one company, so its other campaign shows the new name too.
    expect(campaigns[opp(2)]?.company).toBe('IT Inbound Agency Austria GmbH')
    expect(campaigns[opp(3)]).toMatchObject({ price: '21.500000' })
  })

  it('skips the records it cannot take, says why, and sets up the rest', async () => {
    await pushed(first())

    const next = await pushed([
      // The opportunity moved to another account: a campaign never changes company.
      record(1, { AccountId: OTHER, Account_Name__c: 'IT Inbound Other Agency GmbH' }),
      record(9, { Id: '006-not-an-id' }),
      record(5, { Creative_Languages__c: 'German;Klingon' }),
    ])

    expect(next).toMatchObject({ received: 3, created: 1, updated: 0, unchanged: 0 })
    expect(next.rejected).toEqual([
      expect.objectContaining({ record: 0, opportunityId: opp(1), error: 'company_mismatch' }),
      expect.objectContaining({ record: 1, opportunityId: null, error: 'invalid_record' }),
    ])
    expect(next.warnings).toEqual([
      expect.objectContaining({
        record: 2,
        opportunityId: opp(5),
        message: expect.stringContaining('Klingon') as string,
      }),
    ])
    const campaigns = await stored()
    expect(campaigns[opp(1)]?.company).toBe('IT Inbound Agency GmbH')
    expect(campaigns[opp(5)]?.languages).toEqual(['de'])
    // The refused record created no company either.
    expect(await db.query(`SELECT 1 FROM app.company WHERE external_id = $1`, [OTHER])).toEqual([])
  })

  it('skips campaigns starting before 2026: none is created, and none is updated', async () => {
    await pushed(first())
    const before = await stored()

    const next = await pushed([
      record(10, { Campaign_Start_Date__c: '2025-11-03', Campaign_End_Date__c: '2025-12-31' }),
      record(11, { Campaign_Start_Date__c: null }),
      // Moved to start in 2025, so it is left as it was, not renamed.
      record(1, { Campaign_Start_Date__c: '2025-12-31', Name: 'AT2512 IT Inbound Renamed' }),
      record(12, { Campaign_Start_Date__c: '2026-01-01' }),
    ])

    expect(next).toMatchObject({ received: 4, created: 1, updated: 0, unchanged: 0, rejected: [] })
    expect(next.skipped).toEqual([
      expect.objectContaining({ record: 0, opportunityId: opp(10) }),
      expect.objectContaining({ record: 1, opportunityId: opp(11) }),
      expect.objectContaining({ record: 2, opportunityId: opp(1) }),
    ])
    const after = await stored()
    expect(Object.keys(after).sort()).toEqual([opp(1), opp(2), opp(3), opp(12)])
    expect(after[opp(1)]).toEqual(before[opp(1)])
    expect(after[opp(12)]).toMatchObject({ starts_on: '2026-01-01' })
  })

  it('keeps two accounts of the same name apart: a company is its account, never its name', async () => {
    const summary = await pushed([
      record(6, { AccountId: NAMESAKE_A, Account_Name__c: 'IT Inbound Namesake GmbH' }),
      record(7, { AccountId: NAMESAKE_B, Account_Name__c: 'IT Inbound Namesake GmbH' }),
    ])

    expect(summary).toMatchObject({ created: 2, rejected: [] })
    const campaigns = await stored()
    expect(campaigns[opp(6)]?.company_ref).toBe(NAMESAKE_A)
    expect(campaigns[opp(7)]?.company_ref).toBe(NAMESAKE_B)
    expect(campaigns[opp(6)]?.company_id).not.toBe(campaigns[opp(7)]?.company_id)
  })

  it('keeps the platform ids a person added when the records come again', async () => {
    await pushed(first())
    const [campaign] = await db.query<{ id: string }>(
      `SELECT id FROM app.campaign WHERE external_id = $1`,
      [opp(1)],
    )
    const ids = await app.inject({
      method: 'PUT',
      url: `/campaigns/${campaign?.id ?? ''}/platforms/nexd`,
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { creatives: [{ liveId: 'it-inbound-nx-1', label: 'V1' }] },
    })
    expect(ids.statusCode).toBe(200)

    const again = await pushed(first())

    expect(again).toMatchObject({ unchanged: 3 })
    expect((await stored())[opp(1)]).toMatchObject({ links: 1, primary_source: 'nexd' })
  })

  it('reads a delivery larger than the 64 KiB admin limit, and stores none of the extra fields', async () => {
    const long = 'description '.repeat(3_000)
    const big = [1, 2, 3].map((n) => record(n, { Description: long }))
    expect(JSON.stringify(big).length).toBeGreaterThan(64 * 1024)

    expect(await pushed(big)).toMatchObject({ created: 3, rejected: [] })
    const [hit] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.campaign c WHERE c.external_id LIKE '006ITINBOUND%'
          AND (row_to_json(c)::text LIKE '%description%' OR row_to_json(c)::text LIKE '%Erika%'
               OR row_to_json(c)::text LIKE '%Reveal%' OR row_to_json(c)::text LIKE '%Austria%')`,
    )
    expect(hit?.n).toBe(0)
  })

  it('refuses the admin token', async () => {
    const res = await push(first(), ADMIN)
    expect(res.statusCode).toBe(401)
    expect(await stored()).toEqual({})
  })
})
