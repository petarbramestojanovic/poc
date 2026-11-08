import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import type { HttpClient } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import type { CampaignDeps } from '../../src/modules/campaigns/service.ts'
import type { ProvisioningDeps } from '../../src/modules/provisioning/service.ts'
import type { IngestSummary } from '../../src/modules/salesforce/ingest.ts'
import { createNexdConnector } from '../../src/modules/sync/connectors/nexd/connector.ts'
import { createZeusConnector } from '../../src/modules/sync/connectors/zeus/connector.ts'
import { createRunTracker } from '../../src/modules/sync/engine.ts'
import { createRegistry } from '../../src/modules/sync/registry.ts'
import type { ProvisionCreativeInput, Provisioner } from '../../src/modules/sync/types.ts'
import { at } from '../helpers.ts'

// The Salesforce push that creates a campaign provisions it, behind the answer. Over HTTP with a
// scripted platform; opportunity ids start with '006ITPROVC' and account ids with '001ITPROVC'.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const INBOUND = 'it-provc-inbound-token-long-enough-0123456789'
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
  provisioningEnabled: true,
}

const opp = (n: number) => `006ITPROVC${String(n).padStart(8, '0')}`

const record = (n: number, over: Record<string, unknown> = {}) => ({
  attributes: { type: 'Opportunity', url: `/services/data/v66.0/sobjects/Opportunity/${opp(n)}` },
  Id: opp(n),
  AccountId: '001ITPROVCAGENCY00',
  Name: `AT2611 IT ProvC Campaign ${n}`,
  CurrencyIsoCode: 'EUR',
  Account_Name__c: 'IT ProvC Agency GmbH',
  N_N_Price__c: 13.0682,
  Campaign_Start_Date__c: '2026-11-20',
  Campaign_End_Date__c: '2026-12-20',
  Creative_Type__c: 'Reveal Ad;Swipe Card',
  ...over,
})

function scriptedPlatform() {
  const created: string[] = []
  const provisioner: Provisioner = {
    async provisionCampaign(_ctx, input) {
      if (input.existing.some((r) => r.kind === 'campaign')) return { resources: [], warnings: [] }
      return {
        resources: [{ kind: 'campaign', externalId: `nx-${input.campaign.externalRef?.id}` }],
        warnings: [],
      }
    },
    async provisionCreative(_ctx, input: ProvisionCreativeInput) {
      created.push(input.creative.name)
      const id = `nx-${input.campaign.externalRef?.id}-${input.creative.name.toLowerCase().replace(/ /g, '-')}`
      return {
        resources: [{ kind: 'creative', externalId: id }],
        warnings: [],
        entity: { externalId: `live-${id}`, label: input.creative.name },
      }
    },
  }
  return { created, provisioner }
}

const neverCalled: HttpClient = {
  request: () => Promise.reject(new Error('no network in this test')),
}

describe('provisioning on the push that creates a campaign', () => {
  let db: Db
  let app: FastifyInstance
  const tracker = createRunTracker()
  const platform = scriptedPlatform()

  const cleanup = async () => {
    await db.query(`DELETE FROM app.campaign WHERE external_id LIKE '006ITPROVC%'`)
    await db.query(`DELETE FROM app.company WHERE external_id LIKE '001ITPROVC%'`)
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    const appDb = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    const log = createLogger('silent')
    const registry = createRegistry([
      { ...createNexdConnector(), ...platform.provisioner },
      createZeusConnector(),
    ])
    const campaigns: CampaignDeps = { db: appDb, registry, log }
    const provisioning: ProvisioningDeps = {
      db: appDb,
      registry,
      http: neverCalled,
      httpNoRetry: neverCalled,
      log,
      campaigns,
      env: { NEXD_API_KEY: 'it-provc-key', ZEUS_API_TOKEN: 'it-provc-token' },
      sleep: () => Promise.resolve(),
    }
    app = buildApp({ config, db: appDb, logger: log, tracker, campaigns, provisioning })
    await cleanup()
  })
  afterEach(async () => {
    await tracker.drain(5_000)
    await cleanup()
    platform.created.length = 0
  })
  afterAll(async () => {
    await cleanup()
    await app.close()
    await db.close()
  })

  const push = async (payload: unknown): Promise<IngestSummary> => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${INBOUND}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })
    expect(res.statusCode).toBe(200)
    return res.json<IngestSummary>()
  }

  const runsOf = (oppId: string) =>
    db.query<{ trigger: string; status: string }>(
      `SELECT r.trigger, r.status FROM external.provisioning_run r
         JOIN app.campaign c ON c.id = r.campaign_id
        WHERE c.external_system = 'salesforce' AND c.external_id = $1 ORDER BY r.started_at`,
      [oppId],
    )

  it('answers the push at once and provisions the new campaign behind it, once', async () => {
    const summary = await push(record(1))
    expect(summary).toMatchObject({ created: 1, provisioning: 1 })
    // Nothing of the job has to be done when the push is answered…
    expect(tracker.size).toBeGreaterThanOrEqual(0)
    // …and all of it is done once the tracker drains: that is what app.close() waits for.
    expect(await tracker.drain(5_000)).toBe(true)

    expect(platform.created).toEqual(['Reveal Ad', 'Swipe Card'])
    expect(await runsOf(opp(1))).toEqual([{ trigger: 'crm', status: 'succeeded' }])
    const entities = await db.query<{ source_id: string; level: string; external_id: string }>(
      `SELECT e.source_id, e.level, e.external_id
         FROM external.link_entity e JOIN external.campaign_link l ON l.id = e.link_id
         JOIN app.campaign c ON c.id = l.campaign_id
        WHERE c.external_id = $1 ORDER BY e.source_id, e.level, e.external_id`,
      [opp(1)],
    )
    expect(entities.map((e) => `${e.source_id} ${e.level} ${e.external_id}`)).toEqual([
      `nexd creative live-nx-${opp(1)}-reveal-ad`,
      `nexd creative live-nx-${opp(1)}-swipe-card`,
      `zeus campaign SF-${opp(1)}_nexd-nx-${opp(1)}`,
      `zeus creative SF-${opp(1)}_nexd-nx-${opp(1)}_nexd-nx-${opp(1)}-reveal-ad`,
      `zeus creative SF-${opp(1)}_nexd-nx-${opp(1)}_nexd-nx-${opp(1)}-swipe-card`,
    ])

    // The same record again, and a changed one: updates never provision.
    expect(await push(record(1))).toMatchObject({ created: 0, unchanged: 1, provisioning: 0 })
    expect(await push(record(1, { Name: 'AT2611 IT ProvC Renamed' }))).toMatchObject({
      created: 0,
      updated: 1,
      provisioning: 0,
    })
    expect(await tracker.drain(5_000)).toBe(true)
    expect(await runsOf(opp(1))).toHaveLength(1)
    expect(platform.created).toHaveLength(2)
  })

  it('hands over a campaign without creative types too, and the job records nothing to do', async () => {
    const summary = await push(record(2, { Creative_Type__c: undefined }))
    expect(summary).toMatchObject({ created: 1, provisioning: 1 })
    expect(await tracker.drain(5_000)).toBe(true)
    // Not a failure, so no run: the CRM named nothing to create.
    expect(await runsOf(opp(2))).toEqual([])
    expect(platform.created).toEqual([])
  })

  it('skips what the ingest skips: a campaign before 2026 is neither created nor provisioned', async () => {
    const summary = await push(record(3, { Campaign_Start_Date__c: '2025-06-01' }))
    expect(summary).toMatchObject({ created: 0, provisioning: 0 })
    expect(at(summary.skipped).opportunityId).toBe(opp(3))
    expect(await tracker.drain(1_000)).toBe(true)
  })
})
