import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../../src/core/db.ts'
import type { HttpClient } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import { campaignSetupSchema } from '../../src/modules/campaigns/input.ts'
import {
  findCampaignDetail,
  describeExternalIds,
  setUpCampaign,
  type CampaignDeps,
} from '../../src/modules/campaigns/service.ts'
import {
  NothingToProvisionError,
  ProvisioningInProgressError,
} from '../../src/modules/provisioning/errors.ts'
import { provisionCampaign, type ProvisioningDeps } from '../../src/modules/provisioning/service.ts'
import { createNexdConnector } from '../../src/modules/sync/connectors/nexd/connector.ts'
import { createZeusConnector } from '../../src/modules/sync/connectors/zeus/connector.ts'
import { ProvisionError } from '../../src/modules/sync/errors.ts'
import { createRegistry } from '../../src/modules/sync/registry.ts'
import type {
  ProvisionCampaignInput,
  ProvisionCreativeInput,
  Provisioner,
} from '../../src/modules/sync/types.ts'
import { at } from '../helpers.ts'

// The provisioning job against the real schema and the real setup service, with the NEXD
// connector's two creating steps replaced by a scripted platform (the real ones are unit-tested
// against a scripted API) and the real Zeus connector deriving its ids. Every row this file writes
// hangs off a company named 'IT Prov …'.

const REF = { system: 'salesforce', id: 'it-prov-006-1' }

interface Call {
  step: 'campaign' | 'creative'
  existing: number
  creative?: string
}

/** A platform that creates what it is asked, remembers every call, and can fail on one creative. */
function scriptedPlatform(failOn?: string) {
  const calls: Call[] = []
  const provisioner: Provisioner = {
    async provisionCampaign(ctx, input: ProvisionCampaignInput) {
      calls.push({ step: 'campaign', existing: input.existing.length })
      if (input.existing.some((r) => r.kind === 'campaign')) return { resources: [], warnings: [] }
      // What a real connector does after each answer; this one is too big to keep whole.
      await ctx.capture?.({
        request: { method: 'POST', url: 'https://nexd.test/v2/campaigns?api_key=it-prov-nexd-key' },
        response: { campaign_id: 'nx-it-prov-camp', blob: 'x'.repeat(5_000) },
        status: 200,
        fetchedAt: '2026-11-08T12:00:00.000Z',
      })
      return { resources: [{ kind: 'campaign', externalId: 'nx-it-prov-camp' }], warnings: [] }
    },
    async provisionCreative(_ctx, input: ProvisionCreativeInput) {
      calls.push({
        step: 'creative',
        existing: input.existing.length,
        creative: input.creative.name,
      })
      if (input.creative.name === failOn) throw new ProvisionError('NEXD said no')
      const known = input.existing.find((r) => r.kind === 'creative')
      const id =
        known?.externalId ?? `nx-it-prov-cr-${input.creative.name.toLowerCase().replace(/ /g, '-')}`
      return {
        resources: known ? [] : [{ kind: 'creative', externalId: id }],
        warnings:
          input.creative.name === 'Voting Ad'
            ? ['NEXD refused to rename; kept the import name']
            : [],
        entity: { externalId: `live-${id}`, label: input.creative.name },
      }
    },
  }
  return { calls, provisioner }
}

const neverCalled: HttpClient = {
  request: () => Promise.reject(new Error('the job must not call the network in this test')),
}

describe('provisioning a campaign', () => {
  let db: Db
  const log = createLogger('silent')

  const deps = (
    platform: Provisioner,
  ): { campaigns: CampaignDeps; provisioning: ProvisioningDeps } => {
    const registry = createRegistry([
      { ...createNexdConnector(), ...platform },
      createZeusConnector(),
    ])
    const campaigns: CampaignDeps = { db, registry, log }
    return {
      campaigns,
      provisioning: {
        db,
        registry,
        http: neverCalled,
        httpNoRetry: neverCalled,
        log,
        campaigns,
        env: { NEXD_API_KEY: 'it-prov-nexd-key', ZEUS_API_TOKEN: 'it-prov-zeus-token' },
        sleep: () => Promise.resolve(),
      },
    }
  }

  const cleanup = async () => {
    await db.query(
      `DELETE FROM app.campaign WHERE company_id IN (SELECT id FROM app.company WHERE name LIKE 'IT Prov%')`,
    )
    await db.query(`DELETE FROM app.company WHERE name LIKE 'IT Prov%'`)
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    await cleanup()
  })
  afterEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await db.close()
  })

  const campaignFromCrm = async (
    campaigns: CampaignDeps,
    over: Record<string, unknown> = {},
  ): Promise<string> => {
    const result = await setUpCampaign(
      campaigns,
      campaignSetupSchema.parse({
        externalRef: REF,
        company: {
          name: 'IT Prov Rauch',
          externalRef: { system: 'salesforce', id: 'it_prov_acc' },
        },
        name: 'IT Prov Winter',
        startsOn: '2026-11-15',
        endsOn: '2026-12-15',
        creativeTypes: ['Swipe Card', 'Voting Ad'],
        ...over,
      }),
    )
    return result.campaign.id
  }

  const stored = (campaignId: string) =>
    db.query<{
      source_id: string
      level: string
      external_id: string
      campaign_tag: string
      creative_name: string | null
      config: Record<string, unknown>
    }>(
      `SELECT e.source_id, e.level, e.external_id, e.campaign_tag, c.name AS creative_name, l.config
         FROM external.link_entity e
         JOIN external.campaign_link l ON l.id = e.link_id
         LEFT JOIN app.creative c ON c.id = e.creative_id
        WHERE l.campaign_id = $1
        ORDER BY e.source_id, e.level, e.external_id`,
      [campaignId],
    )

  it('creates one creative per type, provisions each, links every id, and tells Zeus its strings', async () => {
    const { calls, provisioner } = scriptedPlatform()
    const { campaigns, provisioning } = deps(provisioner)
    const campaignId = await campaignFromCrm(campaigns)

    const result = await provisionCampaign(provisioning, campaignId, 'manual')

    expect(result).toMatchObject({
      campaignId,
      creatives: 2,
      sources: [
        { source: 'nexd', resourcesAdded: 3, entitiesAdded: 2 }, // the campaign + two creatives
        { source: 'zeus', resourcesAdded: 0, entitiesAdded: 3 }, // the campaign string + two creative strings
      ],
      warnings: ['NEXD refused to rename; kept the import name'],
    })
    expect(calls).toEqual([
      { step: 'campaign', existing: 0 },
      { step: 'creative', existing: 0, creative: 'Swipe Card' },
      { step: 'creative', existing: 0, creative: 'Voting Ad' },
    ])

    // The creatives: one per type the CRM named, tagged with their own id.
    const detail = await findCampaignDetail(campaigns, campaignId)
    expect(detail.creatives.map((c) => [c.type, c.name, c.tag === c.id])).toEqual([
      ['Swipe Card', 'Swipe Card', true],
      ['Voting Ad', 'Voting Ad', true],
    ])
    const [swipe, voting] = detail.creatives

    // The links: NEXD asked by live id, Zeus by the derived external ids, every id pointing at
    // its creative and stamping that creative's tag.
    const campaignString = `SF-${REF.id}_nexd-nx-it-prov-camp`
    expect(await stored(campaignId)).toEqual([
      {
        source_id: 'nexd',
        level: 'creative',
        external_id: 'live-nx-it-prov-cr-swipe-card',
        campaign_tag: swipe?.tag,
        creative_name: 'Swipe Card',
        config: {},
      },
      {
        source_id: 'nexd',
        level: 'creative',
        external_id: 'live-nx-it-prov-cr-voting-ad',
        campaign_tag: voting?.tag,
        creative_name: 'Voting Ad',
        config: {},
      },
      {
        source_id: 'zeus',
        level: 'campaign',
        external_id: campaignString,
        campaign_tag: '',
        creative_name: null,
        config: { clickthrough_cta_id: 'clickthrough', campaign_id_param: 'external_id' },
      },
      {
        source_id: 'zeus',
        level: 'creative',
        external_id: `${campaignString}_nexd-nx-it-prov-cr-swipe-card`,
        campaign_tag: swipe?.tag,
        creative_name: 'Swipe Card',
        config: { clickthrough_cta_id: 'clickthrough', campaign_id_param: 'external_id' },
      },
      {
        source_id: 'zeus',
        level: 'creative',
        external_id: `${campaignString}_nexd-nx-it-prov-cr-voting-ad`,
        campaign_tag: voting?.tag,
        creative_name: 'Voting Ad',
        config: { clickthrough_cta_id: 'clickthrough', campaign_id_param: 'external_id' },
      },
    ])
    // Everything Zeus must be told is now on its link.
    expect((await describeExternalIds(campaigns, detail)).map((d) => d.linked)).toEqual([
      true,
      true,
      true,
    ])
    // The headline follows the links: Zeus, now that the campaign has Zeus ids.
    expect(detail.primarySource).toBe('zeus')

    // The run record, with what was said to the platform: redacted, and cut down when too big.
    const runs = await db.query<{
      status: string
      trigger: string
      warnings: string[]
      error: string | null
      steps: { request: { url: string }; response: { truncated?: string } }[]
    }>(
      `SELECT status, trigger, warnings, error, steps FROM external.provisioning_run WHERE campaign_id = $1`,
      [campaignId],
    )
    expect(runs).toHaveLength(1)
    expect(at(runs)).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
      warnings: ['NEXD refused to rename; kept the import name'],
      error: null,
    })
    const step = at(at(runs).steps)
    expect(step.request.url).not.toContain('it-prov-nexd-key')
    expect(step.response.truncated).toHaveLength(4_000)
  })

  it('resumes after a failure: nothing done is done twice, nothing undone stays undone', async () => {
    const failing = scriptedPlatform('Voting Ad')
    const first = deps(failing.provisioner)
    const campaignId = await campaignFromCrm(first.campaigns)

    await expect(
      provisionCampaign(first.provisioning, campaignId, 'manual'),
    ).rejects.toBeInstanceOf(ProvisionError)

    // What got done before the failure is stored: the campaign, the first creative, its live id.
    const resources = () =>
      db.query<{ kind: string; external_id: string }>(
        `SELECT kind, external_id FROM external.provisioned_resource WHERE campaign_id = $1 ORDER BY created_at`,
        [campaignId],
      )
    expect(await resources()).toEqual([
      { kind: 'campaign', external_id: 'nx-it-prov-camp' },
      { kind: 'creative', external_id: 'nx-it-prov-cr-swipe-card' },
    ])
    expect((await stored(campaignId)).map((e) => e.external_id)).toEqual([
      'live-nx-it-prov-cr-swipe-card',
    ])
    const [failed] = await db.query<{ status: string; error: string }>(
      `SELECT status, error FROM external.provisioning_run WHERE campaign_id = $1`,
      [campaignId],
    )
    expect(failed).toEqual({ status: 'failed', error: 'NEXD said no' })

    // The second run: the platform is asked again only for what it has not done.
    const healed = scriptedPlatform()
    const second = deps(healed.provisioner)
    const result = await provisionCampaign(second.provisioning, campaignId, 'manual')

    expect(healed.calls).toEqual([
      { step: 'campaign', existing: 1 }, // knows the campaign: creates none
      { step: 'creative', existing: 1, creative: 'Swipe Card' }, // knows the creative: imports none
      { step: 'creative', existing: 0, creative: 'Voting Ad' },
    ])
    expect(result.sources).toEqual([
      { source: 'nexd', resourcesAdded: 1, entitiesAdded: 1 },
      { source: 'zeus', resourcesAdded: 0, entitiesAdded: 3 },
    ])
    expect(await resources()).toHaveLength(3)
    expect((await stored(campaignId)).map((e) => e.external_id)).toHaveLength(5)
    // Still two creatives: a rerun never makes a third.
    expect((await findCampaignDetail(second.campaigns, campaignId)).creatives).toHaveLength(2)
  })

  it('does nothing twice when run again after success', async () => {
    const platform = scriptedPlatform()
    const { campaigns, provisioning } = deps(platform.provisioner)
    const campaignId = await campaignFromCrm(campaigns)
    await provisionCampaign(provisioning, campaignId, 'manual')

    const again = await provisionCampaign(provisioning, campaignId, 'manual')

    expect(again.sources).toEqual([{ source: 'nexd', resourcesAdded: 0, entitiesAdded: 0 }])
    expect((await stored(campaignId)).map((e) => e.external_id)).toHaveLength(5)
  })

  it('refuses a second run while one is running', async () => {
    const { campaigns, provisioning } = deps(scriptedPlatform().provisioner)
    const campaignId = await campaignFromCrm(campaigns)
    await db.query(
      `INSERT INTO external.provisioning_run (campaign_id, trigger) VALUES ($1, 'manual')`,
      [campaignId],
    )

    await expect(provisionCampaign(provisioning, campaignId, 'manual')).rejects.toBeInstanceOf(
      ProvisioningInProgressError,
    )
    expect(
      at(
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM external.provisioning_run WHERE campaign_id = $1`,
          [campaignId],
        ),
      ).n,
    ).toBe('1')
  })

  it('refuses a campaign that names no creative type, writing no run', async () => {
    const { campaigns, provisioning } = deps(scriptedPlatform().provisioner)
    const campaignId = await campaignFromCrm(campaigns, { creativeTypes: undefined })

    await expect(provisionCampaign(provisioning, campaignId, 'manual')).rejects.toBeInstanceOf(
      NothingToProvisionError,
    )
    expect(
      await db.query(`SELECT 1 FROM external.provisioning_run WHERE campaign_id = $1`, [
        campaignId,
      ]),
    ).toEqual([])
  })
})
