import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import { createHttpClient } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import {
  classifyCampaign,
  verifyIndustryMap,
  type IndustryDeps,
} from '../../src/modules/industries/service.ts'
import type { IngestSummary } from '../../src/modules/salesforce/ingest.ts'
import { createDefaultRegistry } from '../../src/modules/sync/connectors/index.ts'
import { createRunTracker, type RunTracker } from '../../src/modules/sync/engine.ts'
import { useTransactionalClient } from './db.ts'

// A campaign's industry after a Salesforce push: the keyword table in the setup's transaction,
// the LLM behind the answer, a value once set never changed by a push, a person's never by the
// classifier. Over HTTP with a scripted OpenRouter. Opportunity ids start with '006ITINDUSTRY'
// and account ids with '001ITINDUSTRY'; no other test file writes either.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const INBOUND = 'it-industry-inbound-token-long-enough-0123456789'
const KEY = 'sk-or-v1-it-industry-0123456789abcdef'
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
  emailReportSchedulerEnabled: false,
}

/** An 18-character opportunity id: '006ITINDUSTRY00001'. */
const opp = (n: number) => `006ITINDUSTRY${String(n).padStart(5, '0')}`

const record = (n: number, over: Record<string, unknown> = {}) => ({
  attributes: { type: 'Opportunity', url: `/services/data/v66.0/sobjects/Opportunity/${opp(n)}` },
  Id: opp(n),
  AccountId: '001ITINDUSTRYACCT1',
  Account_Name__c: 'IT Industry Agency GmbH',
  Name: `AT2611 IT Industry Campaign ${n}`,
  Amount: 13068.2,
  CurrencyIsoCode: 'EUR',
  Type: 'Media Solutions',
  Owner_Name__c: 'Erika Beispiel',
  N_N_Price__c: 13.0682,
  Campaign_Start_Date__c: '2026-11-20',
  Campaign_End_Date__c: '2026-12-20',
  Country__c: 'Austria',
  Creative_Type__c: 'Reveal Ad',
  ...over,
})

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('campaign industry after a Salesforce push', () => {
  const log = createLogger('silent')
  let db: Db
  /** What the scripted OpenRouter answers; replaced per test. */
  let answer: () => Response | Promise<Response>
  /** Every prompt it was sent, in order. */
  let prompts: string[]

  const http = createHttpClient({
    log,
    maxRetries: 2,
    sleep: () => Promise.resolve(),
    random: () => 0,
    // HttpClient hands fetch the JSON body as text.
    fetch: (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: { content: string }[] }
      prompts.push(body.messages[0]?.content ?? '')
      return answer()
    }) as unknown as typeof fetch,
  })

  /** An app whose push classifies behind its answer; `apiKey` unset = keyword table only. */
  function build(apiKey: string | undefined): {
    app: FastifyInstance
    tracker: RunTracker
    deps: IndustryDeps
  } {
    // app.close() closes the pool it was given, so each app gets its own.
    const appDb = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    const tracker = createRunTracker()
    const deps: IndustryDeps = {
      db: appDb,
      http,
      log,
      tracker,
      ...(apiKey === undefined ? {} : { apiKey }),
    }
    const app = buildApp({
      config,
      db: appDb,
      logger: log,
      tracker,
      campaigns: { db: appDb, registry: createDefaultRegistry(), log },
      industries: deps,
    })
    return { app, tracker, deps }
  }

  let withKey: ReturnType<typeof build>
  let withoutKey: ReturnType<typeof build>

  const cleanup = async () => {
    await db.query(`DELETE FROM app.campaign WHERE external_id LIKE '006ITINDUSTRY%'`)
    await db.query(`DELETE FROM app.company WHERE external_id LIKE '001ITINDUSTRY%'`)
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    withKey = build(KEY)
    withoutKey = build(undefined)
    await cleanup()
  })
  beforeEach(() => {
    prompts = []
    answer = () => completion('Retail')
  })
  afterEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await withKey.app.close()
    await withoutKey.app.close()
    await db.close()
  })

  /** Pushes, checks the push was answered, then waits for what it started behind the answer. */
  async function push(
    payload: unknown,
    { app, tracker }: ReturnType<typeof build> = withKey,
  ): Promise<IngestSummary> {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${INBOUND}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })
    expect(res.statusCode).toBe(200)
    expect(await tracker.drain(5_000)).toBe(true)
    return res.json<IngestSummary>()
  }

  /** The stored columns, by name. */
  const stored = async (n: number) => {
    const [row] = await db.query<{ id: string; industry: string | null; source: string | null }>(
      `SELECT id, industry, industry_source AS source FROM app.campaign
        WHERE external_system = 'salesforce' AND external_id = $1`,
      [opp(n)],
    )
    return row
  }

  it('classifies an unknown brand with the LLM, behind the answer', async () => {
    const summary = await push(record(1))

    expect(summary).toMatchObject({ created: 1, classifying: 1 })
    expect(await stored(1)).toMatchObject({ industry: 'Retail', source: 'llm' })
    expect(prompts).toHaveLength(1)
  })

  it('sends the campaign name, the account name and the country, nothing else of the deal', async () => {
    await push(record(2))

    const [prompt = ''] = prompts
    expect(prompt).toContain('Kampagnenname: AT2611 IT Industry Campaign 2')
    expect(prompt).toContain('Kunde: IT Industry Agency GmbH')
    expect(prompt).toContain('Land: Austria')
    for (const said of ['13068', 'Erika', 'Media Solutions', 'Reveal Ad', '13.0682', opp(2)]) {
      expect(prompt).not.toContain(said)
    }
  })

  it('gives a known brand its industry in the push itself, and asks no one', async () => {
    const summary = await push(record(3, { Name: 'DE2611 IT Industry LIDL Punkte' }))

    expect(summary).toMatchObject({ created: 1, classifying: 0 })
    expect(await stored(3)).toMatchObject({ industry: 'Food Retail', source: 'map' })
    expect(prompts).toEqual([])
  })

  it('leaves it empty when the LLM fails, answers the push all the same, and tries again', async () => {
    answer = () => new Response('upstream down', { status: 503 })
    const first = await push(record(4))
    expect(first).toMatchObject({ created: 1, classifying: 1, rejected: [] })
    expect(await stored(4)).toMatchObject({ industry: null, source: null })
    expect(prompts).toHaveLength(3) // the first try and two retries

    // The same record again: nothing about the campaign changed, but it is still empty.
    answer = () => completion('FMCG/CPG')
    const second = await push(record(4))
    expect(second).toMatchObject({ unchanged: 1, classifying: 1 })
    expect(await stored(4)).toMatchObject({ industry: 'FMCG / CPG', source: 'llm' })

    // Set now: the next push leaves it alone and asks no one.
    const third = await push(record(4))
    expect(third).toMatchObject({ unchanged: 1, classifying: 0 })
    expect(prompts).toHaveLength(4)
  })

  it('never changes an industry once set, whatever the next push says', async () => {
    await push(record(5))
    const renamed = await push(record(5, { Name: 'DE2611 IT Industry Penny Promo' }))

    expect(renamed).toMatchObject({ updated: 1, classifying: 0 })
    expect(await stored(5)).toMatchObject({ industry: 'Retail', source: 'llm' })
  })

  it('never overwrites a value a person set while the LLM was thinking', async () => {
    answer = () => new Response('busy', { status: 503 })
    await push(record(6))
    const campaign = await stored(6)
    if (!campaign) throw new Error('campaign 6 was not created')

    // The person's value lands between the read and the write.
    answer = async () => {
      await db.query(
        `UPDATE app.campaign SET industry = 'Tech-Telco', industry_source = 'manual' WHERE id = $1`,
        [campaign.id],
      )
      return completion('Retail')
    }
    const outcome = await classifyCampaign(withKey.deps, campaign.id)

    expect(outcome).toEqual({
      campaignId: campaign.id,
      outcome: 'kept',
      industry: 'Tech-Telco',
      via: null,
    })
    expect(await stored(6)).toMatchObject({ industry: 'Tech-Telco', source: 'manual' })
  })

  it('without a key, uses the keyword table only', async () => {
    const unknown = await push(record(7), withoutKey)
    expect(unknown).toMatchObject({ created: 1, classifying: 1 })
    expect(await stored(7)).toMatchObject({ industry: null, source: null })

    // A campaign still empty when a push renames it after a known brand is classified by the table.
    const renamed = await push(record(7, { Name: 'AT2611 IT Industry Stiegl Bier' }), withoutKey)
    expect(renamed).toMatchObject({ updated: 1, classifying: 1 })
    expect(await stored(7)).toMatchObject({ industry: 'FMCG / CPG', source: 'map' })
    expect(prompts).toEqual([])
  })

  it('says unresolved for a campaign nothing could decide, writing nothing', async () => {
    await push(record(8), withoutKey)
    const campaign = await stored(8)
    if (!campaign) throw new Error('campaign 8 was not created')

    expect(await classifyCampaign(withoutKey.deps, campaign.id)).toEqual({
      campaignId: campaign.id,
      outcome: 'unresolved',
      industry: null,
      via: null,
    })
  })

  it('refuses a campaign that does not exist with the campaigns module code', async () => {
    await expect(
      classifyCampaign(withKey.deps, '00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toMatchObject({ code: 'campaign_not_found', status: 404 })
  })
})

describe('verifyIndustryMap, at boot', () => {
  const { sql } = useTransactionalClient()
  const tx = { query: sql }

  it('passes while app.industry has every industry the keyword table and the LLM name', async () => {
    await expect(verifyIndustryMap(tx)).resolves.toBeUndefined()
  })

  it('fails the boot when one is missing, naming it', async () => {
    // Renamed inside the test's transaction, which is rolled back.
    await sql(`UPDATE app.industry SET name = 'Food Retailers' WHERE name = 'Food Retail'`)
    await sql(`UPDATE app.industry SET name = 'Misc' WHERE name = 'Other Industries'`)
    await expect(verifyIndustryMap(tx)).rejects.toThrow(/Food Retail, Other Industries$/)
  })
})
