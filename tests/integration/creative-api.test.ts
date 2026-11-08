import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import type { HttpClient } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import { campaignSetupSchema } from '../../src/modules/campaigns/input.ts'
import { nexdPresetSchema, nexdSetup } from '../../src/modules/campaigns/presets.ts'
import {
  setPlatformIds,
  setUpCampaign,
  type CampaignDeps,
} from '../../src/modules/campaigns/service.ts'
import type { ProvisioningDeps } from '../../src/modules/provisioning/service.ts'
import { createNexdConnector } from '../../src/modules/sync/connectors/nexd/connector.ts'
import { createZeusConnector } from '../../src/modules/sync/connectors/zeus/connector.ts'
import { createRegistry } from '../../src/modules/sync/registry.ts'
import type {
  ProvisionCampaignInput,
  ProvisionCreativeInput,
  Provisioner,
} from '../../src/modules/sync/types.ts'

// POST /campaigns/:id/creatives over HTTP: the Tchibo case. A campaign set up before provisioning
// existed, its NEXD campaign and creatives set by hand, gets one more creative through our API,
// which creates it on the platforms at once — in the NEXD campaign the person named, never a new
// one. Rows hang off a company named 'IT Creative API …'.

const TOKEN = 'a-long-enough-operator-token-0123456789'
const auth = { authorization: `Bearer ${TOKEN}` }

const config: Config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: TOKEN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
}

interface Call {
  step: string
  existing: number
  linked?: string[]
  creative?: string
}

function scriptedPlatform() {
  const calls: Call[] = []
  const provisioner: Provisioner = {
    async provisionCampaign(_ctx, input: ProvisionCampaignInput) {
      calls.push({
        step: 'campaign',
        existing: input.existing.length,
        linked: (input.linked ?? []).map((e) => `${e.level}/${e.externalId}`),
      })
      if (input.existing.some((r) => r.kind === 'campaign')) return { resources: [], warnings: [] }
      // The real NEXD step adopts a linked campaign; the scripted one does the same.
      const adopted = input.linked?.find((e) => e.level === 'campaign')
      return {
        resources: [{ kind: 'campaign', externalId: adopted?.externalId ?? 'nx-it-capi-new' }],
        warnings: [],
      }
    },
    async provisionCreative(_ctx, input: ProvisionCreativeInput) {
      calls.push({
        step: 'creative',
        existing: input.existing.length,
        creative: input.creative.name,
      })
      const id = `nx-it-capi-${input.creative.name.toLowerCase().replace(/ /g, '-')}`
      return {
        resources: [{ kind: 'creative', externalId: id }],
        warnings: [],
        entity: { externalId: `live-${id}`, label: input.creative.name },
      }
    },
  }
  return { calls, provisioner }
}

const neverCalled: HttpClient = {
  request: () => Promise.reject(new Error('no network in this test')),
}

describe('POST /campaigns/:id/creatives', () => {
  let db: Db
  let app: FastifyInstance
  let campaigns: CampaignDeps
  const platform = scriptedPlatform()

  const cleanup = async () => {
    await db.query(
      `DELETE FROM app.campaign WHERE company_id IN (SELECT id FROM app.company WHERE name LIKE 'IT Creative API%')`,
    )
    await db.query(`DELETE FROM app.company WHERE name LIKE 'IT Creative API%'`)
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    const appDb = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    const log = createLogger('silent')
    const registry = createRegistry([
      { ...createNexdConnector(), ...platform.provisioner },
      createZeusConnector(),
    ])
    campaigns = { db, registry, log }
    const provisioning: ProvisioningDeps = {
      db: appDb,
      registry,
      http: neverCalled,
      httpNoRetry: neverCalled,
      log,
      campaigns: { db: appDb, registry, log },
      env: { NEXD_API_KEY: 'it-capi-key', ZEUS_API_TOKEN: 'it-capi-token' },
      sleep: () => Promise.resolve(),
    }
    app = buildApp({
      config,
      db: appDb,
      logger: log,
      campaigns: { db: appDb, registry, log },
      provisioning,
    })
    await cleanup()
  })
  afterEach(async () => {
    await cleanup()
    platform.calls.length = 0
  })
  afterAll(async () => {
    await cleanup()
    await app.close()
    await db.close()
  })

  /** Tchibo-like: from the CRM, then its existing NEXD campaign and one creative set by hand. */
  const existingCampaign = async (): Promise<string> => {
    const result = await setUpCampaign(
      campaigns,
      campaignSetupSchema.parse({
        externalRef: { system: 'salesforce', id: 'it-capi-006-1' },
        company: { name: 'IT Creative API Tchibo' },
        name: 'IT Creative API Always-On',
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      }),
    )
    await setPlatformIds(
      campaigns,
      result.campaign.id,
      nexdSetup(
        nexdPresetSchema.parse({
          campaignId: 'nx-it-capi-existing',
          creatives: [{ liveId: 'it-capi-old-live', label: 'Old game' }],
        }),
      ),
    )
    return result.campaign.id
  }

  const post = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/campaigns/${id}/creatives`, headers: auth, payload })

  it('adds the creative and creates it in the NEXD campaign the person named', async () => {
    const campaignId = await existingCampaign()

    const response = await post(campaignId, { name: 'New Game', type: 'Swipe Card' })

    expect(response.statusCode).toBe(201)
    const body = response.json<{
      creative: { id: string; tag: string; type: string; name: string }
      run: { sources: { source: string; resourcesAdded: number; entitiesAdded: number }[] }
    }>()
    expect(body.creative).toMatchObject({ type: 'Swipe Card', name: 'New Game' })
    expect(body.creative.tag).toBe(body.creative.id)
    expect(body.run.sources).toEqual([
      { source: 'nexd', resourcesAdded: 2, entitiesAdded: 1 }, // the adopted campaign + the creative
      { source: 'zeus', resourcesAdded: 0, entitiesAdded: 2 }, // the campaign string + this creative's
    ])

    // The platform was told about the existing campaign and asked for this creative only.
    expect(platform.calls).toEqual([
      {
        step: 'campaign',
        existing: 0,
        linked: ['campaign/nx-it-capi-existing', 'creative/it-capi-old-live'],
      },
      { step: 'creative', existing: 0, creative: 'New Game' },
    ])

    // The link: the old creative untouched, the new one's live id beside it, both pointing at
    // their creatives; Zeus told the strings built on the existing NEXD campaign.
    const entities = await db.query<{
      source_id: string
      level: string
      external_id: string
      creative_name: string | null
    }>(
      `SELECT e.source_id, e.level, e.external_id, c.name AS creative_name
         FROM external.link_entity e
         JOIN external.campaign_link l ON l.id = e.link_id
         LEFT JOIN app.creative c ON c.id = e.creative_id
        WHERE l.campaign_id = $1 ORDER BY e.source_id, e.level, e.external_id`,
      [campaignId],
    )
    expect(entities).toEqual([
      {
        source_id: 'nexd',
        level: 'campaign',
        external_id: 'nx-it-capi-existing',
        creative_name: null,
      },
      {
        source_id: 'nexd',
        level: 'creative',
        external_id: 'it-capi-old-live',
        creative_name: 'Old game',
      },
      {
        source_id: 'nexd',
        level: 'creative',
        external_id: 'live-nx-it-capi-new-game',
        creative_name: 'New Game',
      },
      {
        source_id: 'zeus',
        level: 'campaign',
        external_id: 'SF-it-capi-006-1_nexd-nx-it-capi-existing',
        creative_name: null,
      },
      {
        source_id: 'zeus',
        level: 'creative',
        external_id: 'SF-it-capi-006-1_nexd-nx-it-capi-existing_nexd-nx-it-capi-new-game',
        creative_name: 'New Game',
      },
    ])
    // Two creatives in all: the hand-set one and the new one. Nothing created twice.
    expect(
      await db.query(`SELECT 1 FROM app.creative WHERE campaign_id = $1`, [campaignId]),
    ).toHaveLength(2)
  })

  it('refuses a blank name, and a campaign that does not exist', async () => {
    const campaignId = await existingCampaign()
    expect((await post(campaignId, { name: '   ' })).statusCode).toBe(400)
    expect((await post(campaignId, { name: 'X', extra: 1 })).statusCode).toBe(400)
    expect((await post('00000000-0000-4000-8000-00000000dead', { name: 'X' })).statusCode).toBe(404)
    expect(platform.calls).toEqual([])
  })

  it('is an admin route: no token, no answer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/campaigns/00000000-0000-4000-8000-00000000dead/creatives',
      payload: { name: 'X' },
    })
    expect(response.statusCode).toBe(401)
    expect(platform.calls).toEqual([])
  })
})
