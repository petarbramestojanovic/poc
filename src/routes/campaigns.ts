import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { CampaignNotFoundError } from '../campaigns/errors.ts'
import { externalRefSchema, type SourceSetup } from '../campaigns/input.ts'
import { PLATFORM_PRESETS, type PresetPlatform } from '../campaigns/presets.ts'
import * as repo from '../campaigns/repo.ts'
import { removePlatform, setPlatformIds, type CampaignDeps } from '../campaigns/service.ts'

// /companies and /campaigns, each registered inside its own admin scope, so the bearer check runs
// first. Campaigns and companies are created only by the Salesforce report (POST
// /inbound/campaigns), and their own fields belong to it: a person reads them here and sets one
// thing, each platform's ids, through the same presets the setup service has always used.
//
// PUT /campaigns/:id/platforms/:platform is the whole id list for that platform. Adding ids always
// works; changing or dropping one answers 409 platform_has_data once that platform has written
// analytics for the campaign. DELETE takes the platform off under the same rule.

const externalRefResponse = externalRefSchema.nullable()

const companyResponse = z.object({
  id: z.guid(),
  name: z.string(),
  externalRef: externalRefResponse,
})

const campaignResponse = z.object({
  id: z.guid(),
  companyId: z.guid(),
  name: z.string(),
  primarySource: z.string(),
  timezone: z.string(),
  languages: z.array(z.string()),
  startsOn: z.iso.date().nullable(),
  endsOn: z.iso.date().nullable(),
  status: z.enum(['draft', 'active', 'archived']),
  price: z.object({ value: z.number(), currency: z.string() }).nullable(),
  externalRef: externalRefResponse,
  createdAt: z.date(),
  updatedAt: z.date(),
})

const linkSummary = z.object({
  id: z.guid(),
  source: z.string(),
  language: z.string(),
  enabled: z.boolean(),
  entities: z.number(),
})

const linkDetail = linkSummary.extend({
  config: z.record(z.string(), z.unknown()),
  entities: z.array(
    z.object({
      level: z.string(),
      externalId: z.string(),
      role: z.string().nullable(),
      label: z.string().nullable(),
      campaignTag: z.string(),
    }),
  ),
})

// --- /companies -----------------------------------------------------------------------------

export const companyRoutes: FastifyPluginAsync<{ deps: CampaignDeps }> = async (app, { deps }) => {
  app.get(
    '/',
    { schema: { response: { 200: z.array(companyResponse.extend({ campaigns: z.number() })) } } },
    async () => repo.listCompanies(deps.db),
  )
}

// --- /campaigns -----------------------------------------------------------------------------

const campaignParams = z.object({ id: z.guid() })
const listQuery = z.strictObject({ companyId: z.guid().optional() })
const platformQuery = z.strictObject({ language: z.string().trim().max(16).default('') })
const detailResponse = campaignResponse.extend({
  companyName: z.string(),
  links: z.array(linkDetail),
})
const changeResponse = z.object({
  outcome: z.enum(['created', 'added', 'replaced', 'unchanged']),
  campaign: detailResponse,
})

async function detail(deps: CampaignDeps, id: string): Promise<repo.CampaignDetail> {
  const campaign = await repo.getCampaign(deps.db, id)
  if (!campaign) throw new CampaignNotFoundError(`campaign ${id} does not exist`)
  return campaign
}

export const campaignRoutes: FastifyPluginAsync<{ deps: CampaignDeps }> = async (app, { deps }) => {
  app.get<{ Querystring: z.infer<typeof listQuery> }>(
    '/',
    {
      schema: {
        querystring: listQuery,
        response: {
          200: z.array(
            campaignResponse.extend({ companyName: z.string(), links: z.array(linkSummary) }),
          ),
        },
      },
    },
    async (request) => repo.listCampaigns(deps.db, request.query.companyId),
  )

  app.get<{ Params: z.infer<typeof campaignParams> }>(
    '/:id',
    { schema: { params: campaignParams, response: { 200: detailResponse } } },
    async (request) => detail(deps, request.params.id),
  )

  for (const platform of Object.keys(PLATFORM_PRESETS) as PresetPlatform[]) {
    const preset = PLATFORM_PRESETS[platform]

    app.put<{ Params: z.infer<typeof campaignParams>; Body: z.infer<typeof preset.schema> }>(
      `/:id/platforms/${platform}`,
      {
        schema: { params: campaignParams, body: preset.schema, response: { 200: changeResponse } },
      },
      async (request) => {
        // Each preset's toSetup takes its own schema's output; the loop cannot see the pairing.
        const toSetup = preset.toSetup as (input: typeof request.body) => SourceSetup
        const { outcome } = await setPlatformIds(deps, request.params.id, toSetup(request.body))
        return { outcome, campaign: await detail(deps, request.params.id) }
      },
    )

    app.delete<{
      Params: z.infer<typeof campaignParams>
      Querystring: z.infer<typeof platformQuery>
    }>(
      `/:id/platforms/${platform}`,
      {
        schema: {
          params: campaignParams,
          querystring: platformQuery,
          response: { 200: detailResponse },
        },
      },
      async (request) => {
        await removePlatform(deps, request.params.id, platform, request.query.language)
        return detail(deps, request.params.id)
      },
    )
  }
}
