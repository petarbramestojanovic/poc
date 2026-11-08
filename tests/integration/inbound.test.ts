import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import { createLogger } from '../../src/core/log.ts'
import { ingestOpportunities, type IngestSummary } from '../../src/modules/salesforce/ingest.ts'
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
      provisioning: 0,
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

  describe('what a record says about the deal', () => {
    const MANAGER = '005ITINBOUNDMGR001'
    const OTHER_MANAGER = '005ITINBOUNDMGR002'

    interface StoredDeal {
      amount: string | null
      amount_currency: string | null
      deal_type: string | null
      country: string | null
      creative_types: string[]
      owner_name: string | null
      manager_external_id: string | null
      manager_name: string | null
      external_modified_at: Date | null
      updated_at: Date
    }

    /** Read back by column name: insert_campaign.sql and update_campaign.sql are positional. */
    const storedDeal = async (n: number): Promise<StoredDeal | undefined> => {
      const [row] = await db.query<StoredDeal>(
        `SELECT amount::text AS amount, amount_currency, deal_type, country, creative_types,
                owner_name, manager_external_id, manager_name, external_modified_at, updated_at
           FROM app.campaign WHERE external_id = $1`,
        [opp(n)],
      )
      return row
    }

    const saysNothing = {
      Amount: null,
      Type: null,
      LastModifiedDate: null,
      Owner_Name__c: null,
      Country__c: null,
      Creative_Type__c: null,
    }

    const adminGet = async <T>(url: string): Promise<T> => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${ADMIN}` },
      })
      expect(res.statusCode).toBe(200)
      return res.json<T>()
    }

    const campaignIdOf = async (n: number): Promise<string> => {
      const [row] = await db.query<{ id: string }>(
        `SELECT id FROM app.campaign WHERE external_id = $1`,
        [opp(n)],
      )
      if (!row) throw new Error(`no campaign for ${opp(n)}`)
      return row.id
    }

    it('stores every field on the campaign, each in its own column', async () => {
      const summary = await pushed(
        record(20, {
          Amount: 7128.75,
          Creative_Type__c: 'Reveal Ad;Swipe Card',
          Campaign_Manager__c: MANAGER,
          Campaign_Manager__r: { attributes: { type: 'User' }, Name: 'Max Muster' },
          LastModifiedDate: '2026-10-11T22:00:16.000+0200',
        }),
      )

      expect(summary).toMatchObject({ created: 1, rejected: [], warnings: [] })
      expect(await storedDeal(20)).toMatchObject({
        amount: '7128.75',
        amount_currency: 'EUR',
        deal_type: 'Media Solutions',
        country: 'Austria',
        creative_types: ['Reveal Ad', 'Swipe Card'],
        owner_name: 'Erika Beispiel',
        manager_external_id: MANAGER,
        manager_name: 'Max Muster',
        external_modified_at: new Date('2026-10-11T20:00:16.000Z'),
      })
    })

    it('writes each field to its own column on an update too', async () => {
      await pushed(record(19, saysNothing))

      const next = await pushed(
        record(19, {
          Amount: 500.5,
          Type: 'Tailor_Made',
          Country__c: 'Germany',
          Creative_Type__c: 'Catcher',
          Owner_Name__c: 'Otto Owner',
          Campaign_Manager__c: MANAGER,
          Campaign_Manager__r: { Name: 'Max Muster' },
          LastModifiedDate: '2026-10-12T08:00:00.000+0000',
        }),
      )

      expect(next).toMatchObject({ updated: 1, rejected: [] })
      expect(await storedDeal(19)).toMatchObject({
        amount: '500.50',
        amount_currency: 'EUR',
        deal_type: 'Tailor_Made',
        country: 'Germany',
        creative_types: ['Catcher'],
        owner_name: 'Otto Owner',
        manager_external_id: MANAGER,
        manager_name: 'Max Muster',
        external_modified_at: new Date('2026-10-12T08:00:00.000Z'),
      })
    })

    it('takes a record whose names come through relationships', async () => {
      const summary = await pushed(
        record(21, {
          Account_Name__c: undefined,
          Account: { attributes: { type: 'Account' }, Name: 'IT Inbound Agency GmbH' },
          Owner_Name__c: undefined,
          Owner: { attributes: { type: 'User' }, Name: 'Otto Owner' },
        }),
      )

      expect(summary).toMatchObject({ created: 1, rejected: [] })
      expect((await stored())[opp(21)]?.company).toBe('IT Inbound Agency GmbH')
      expect((await storedDeal(21))?.owner_name).toBe('Otto Owner')
    })

    it('takes a record exactly as the sheet has it, and the same one as REST JSON changes nothing', async () => {
      const {
        attributes: _attributes,
        Account_Name__c: _account,
        Owner_Name__c: _owner,
        ...fields
      } = record(34)
      const flat = {
        ...fields,
        _: '[Opportunity]',
        Account: '[Account]',
        'Account.Name': 'IT Inbound Agency GmbH',
        Owner: '[User]',
        'Owner.Name': 'Otto Owner',
        Campaign_Manager__c: MANAGER,
        Campaign_Manager__r: '[User]',
        'Campaign_Manager__r.Name': 'Max Muster',
      }

      const summary = await pushed([flat])

      expect(summary).toMatchObject({ created: 1, rejected: [], warnings: [] })
      expect((await stored())[opp(34)]).toMatchObject({
        company: 'IT Inbound Agency GmbH',
        company_ref: AGENCY,
      })
      const before = await storedDeal(34)
      expect(before).toMatchObject({
        amount: '13068.20',
        owner_name: 'Otto Owner',
        manager_external_id: MANAGER,
        manager_name: 'Max Muster',
      })

      const again = await pushed([
        {
          ...fields,
          attributes: { type: 'Opportunity' },
          Account: { attributes: { type: 'Account' }, Name: 'IT Inbound Agency GmbH' },
          Owner: { attributes: { type: 'User' }, Name: 'Otto Owner' },
          Campaign_Manager__c: MANAGER,
          Campaign_Manager__r: { attributes: { type: 'User' }, Name: 'Max Muster' },
        },
      ])

      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1, rejected: [] })
      expect(await storedDeal(34)).toEqual(before)
    })

    it('writes nothing when the same record comes again', async () => {
      await pushed(record(22))
      const before = await storedDeal(22)

      const again = await pushed(record(22))

      expect(again).toMatchObject({ updated: 0, unchanged: 1 })
      expect(await storedDeal(22)).toEqual(before)
    })

    it('counts a change to these fields alone as an update', async () => {
      await pushed(record(23))
      const before = await storedDeal(23)

      const next = await pushed(record(23, { Amount: 9000.5, Country__c: 'Germany' }))

      expect(next).toMatchObject({ updated: 1, unchanged: 0 })
      const after = await storedDeal(23)
      expect(after).toMatchObject({ amount: '9000.50', country: 'Germany' })
      expect(after?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? Infinity)
    })

    it('fills them on a campaign that had none, as a resend of an old import does', async () => {
      await pushed(record(24, saysNothing))
      expect(await storedDeal(24)).toMatchObject({
        amount: null,
        amount_currency: null,
        deal_type: null,
        creative_types: [],
        manager_external_id: null,
      })

      const next = await pushed(record(24))

      expect(next).toMatchObject({ updated: 1 })
      expect(await storedDeal(24)).toMatchObject({ deal_type: 'Media Solutions' })
    })

    it('never clears what a later record leaves out', async () => {
      await pushed(record(25, { Campaign_Manager__c: MANAGER }))
      const before = await storedDeal(25)

      const next = await pushed(record(25, saysNothing))

      expect(next).toMatchObject({ unchanged: 1 })
      expect(await storedDeal(25)).toEqual(before)
    })

    it('keeps the manager name for the same person, and drops it for another', async () => {
      await pushed(
        record(26, { Campaign_Manager__c: MANAGER, Campaign_Manager__r: { Name: 'Max Muster' } }),
      )

      await pushed(record(26, { Campaign_Manager__c: MANAGER }))
      expect(await storedDeal(26)).toMatchObject({
        manager_external_id: MANAGER,
        manager_name: 'Max Muster',
      })

      // The previous manager's name must not stay on the next manager's id.
      await pushed(record(26, { Campaign_Manager__c: OTHER_MANAGER }))
      expect(await storedDeal(26)).toMatchObject({
        manager_external_id: OTHER_MANAGER,
        manager_name: null,
      })
    })

    it('leaves out an amount it cannot store exactly, rather than round it', async () => {
      const summary = await pushed(record(27, { Amount: 7128.755 }))

      expect(summary).toMatchObject({ created: 1, rejected: [] })
      expect(summary.warnings).toEqual([
        expect.objectContaining({
          opportunityId: opp(27),
          message: expect.stringContaining('Amount') as string,
        }),
      ])
      expect(await storedDeal(27)).toMatchObject({
        amount: null,
        amount_currency: null,
        deal_type: 'Media Solutions',
      })
    })

    it('writes none of it for a record the service refuses', async () => {
      await pushed(record(28))
      const before = await storedDeal(28)

      const next = await pushed(
        record(28, {
          AccountId: OTHER,
          Account_Name__c: 'IT Inbound Other Agency GmbH',
          Amount: 1,
        }),
      )

      expect(next.rejected).toEqual([expect.objectContaining({ error: 'company_mismatch' })])
      expect(await storedDeal(28)).toEqual(before)
    })

    it('survives a person changing the platform ids, which rewrites the campaign row', async () => {
      await pushed(
        record(33, { Campaign_Manager__c: MANAGER, Campaign_Manager__r: { Name: 'Max Muster' } }),
      )
      const before = await storedDeal(33)

      const ids = await app.inject({
        method: 'PUT',
        url: `/campaigns/${await campaignIdOf(33)}/platforms/nexd`,
        headers: { authorization: `Bearer ${ADMIN}` },
        payload: { creatives: [{ liveId: 'it-inbound-nx-33', label: 'V1' }] },
      })

      expect(ids.statusCode).toBe(200)
      // Only NEXD ids, so the headline moved to NEXD and the row was written.
      expect((await stored())[opp(33)]?.primary_source).toBe('nexd')
      const { updated_at: _before, ...fields } = before ?? ({} as StoredDeal)
      expect(await storedDeal(33)).toMatchObject(fields)
    })

    it('is what an admin reads, and empty for a campaign without any', async () => {
      await pushed([
        record(29, { Campaign_Manager__c: MANAGER, Campaign_Manager__r: { Name: 'Max Muster' } }),
        record(30, saysNothing),
      ])
      const [known, unknown] = [await campaignIdOf(29), await campaignIdOf(30)]
      const said = {
        amount: { value: 13068.2, currency: 'EUR' },
        dealType: 'Media Solutions',
        country: 'Austria',
        creativeTypes: ['Reveal Ad'],
        ownerName: 'Erika Beispiel',
        manager: { id: MANAGER, name: 'Max Muster' },
        externalModifiedAt: '2026-10-11T22:00:16.000Z',
      }
      const unsaid = {
        amount: null,
        dealType: null,
        country: null,
        creativeTypes: [],
        ownerName: null,
        manager: null,
        externalModifiedAt: null,
      }

      expect(await adminGet(`/campaigns/${known}`)).toMatchObject(said)
      expect(await adminGet(`/campaigns/${unknown}`)).toMatchObject(unsaid)

      const list = await adminGet<{ id: string }[]>('/campaigns')
      expect(list.find((campaign) => campaign.id === known)).toMatchObject(said)
      expect(list.find((campaign) => campaign.id === unknown)).toMatchObject(unsaid)
    })

    it('never logs any of it', async () => {
      const lines: string[] = []
      const capturing = pino({ level: 'info' }, { write: (line) => lines.push(line) })

      await ingestOpportunities({ db, registry: createDefaultRegistry(), log: capturing }, [
        record(31, { Campaign_Manager__c: MANAGER, Campaign_Manager__r: { Name: 'Max Muster' } }),
        record(32, { Amount: 'Erika owes' }),
      ])

      const logged = lines.join('\n')
      expect(logged).toContain('salesforce opportunities ingested')
      for (const value of ['Erika', 'Max Muster', '13068', 'Austria', MANAGER]) {
        expect(logged).not.toContain(value)
      }
    })
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

  it('reads a delivery larger than the 64 KiB admin limit, and stores no field it does not map', async () => {
    const long = 'description '.repeat(3_000)
    const big = [1, 2, 3].map((n) => record(n, { Description: long }))
    expect(JSON.stringify(big).length).toBeGreaterThan(64 * 1024)

    expect(await pushed(big)).toMatchObject({ created: 3, rejected: [] })
    const [hit] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.campaign c WHERE c.external_id LIKE '006ITINBOUND%'
          AND row_to_json(c)::text LIKE '%description%'`,
    )
    expect(hit?.n).toBe(0)
  })

  it('refuses the admin token', async () => {
    const res = await push(first(), ADMIN)
    expect(res.statusCode).toBe(401)
    expect(await stored()).toEqual({})
  })
})
