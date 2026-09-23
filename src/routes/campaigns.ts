import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { CampaignNotFoundError } from '../campaigns/errors.ts'
import {
  campaignFields,
  campaignPatchSchema,
  campaignSetupSchema,
  companyRefSchema,
  externalRefSchema,
  startsBeforeEnd,
  type CampaignPatch,
} from '../campaigns/input.ts'
import { platformSourcesSchema, toSourceSetups } from '../campaigns/presets.ts'
import * as repo from '../campaigns/repo.ts'
import {
  editCampaign,
  setUpCampaign,
  upsertCompany,
  type CampaignDeps,
} from '../campaigns/service.ts'

// /companies and /campaigns, each registered inside its own admin scope, so the bearer check runs
// first. These routes are the "by hand" adapter of the setup service: they translate a request
// into a CampaignSetup — through the same platform presets a CRM adapter will use — and hand it
// to setUpCampaign. No SQL and no rule of their own lives here.
//
// POST /campaigns is safe to repeat when the body carries an `externalRef`: 201 the first time,
// 200 afterwards, and the second push only updates fields and adds what is missing.

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

const companyBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  externalRef: externalRefSchema.optional(),
})

export const companyRoutes: FastifyPluginAsync<{ deps: CampaignDeps }> = async (app, { deps }) => {
  app.get(
    '/',
    { schema: { response: { 200: z.array(companyResponse.extend({ campaigns: z.number() })) } } },
    async () => repo.listCompanies(deps.db),
  )

  app.post<{ Body: z.infer<typeof companyBody> }>(
    '/',
    { schema: { body: companyBody, response: { 200: companyResponse, 201: companyResponse } } },
    async (request, reply) => {
      const { created, company } = await upsertCompany(deps, request.body)
      return reply.code(created ? 201 : 200).send(company)
    },
  )
}

// --- /campaigns -----------------------------------------------------------------------------

const campaignParams = z.object({ id: z.guid() })
const listQuery = z.strictObject({ companyId: z.guid().optional() })

/** The campaign's own fields plus one optional block per platform (presets.ts). */
const setupBody = z
  .strictObject({
    externalRef: externalRefSchema.optional(),
    company: companyRefSchema,
    ...campaignFields,
    sources: platformSourcesSchema.default({}),
  })
  .refine(startsBeforeEnd, { error: 'endsOn is before startsOn', path: ['endsOn'] })
type SetupBody = z.infer<typeof setupBody>

const setupResponse = z.object({
  created: z.boolean(),
  company: companyResponse,
  campaign: campaignResponse,
  links: z.array(
    z.object({
      id: z.guid(),
      source: z.string(),
      language: z.string(),
      created: z.boolean(),
      entitiesAdded: z.number(),
    }),
  ),
})

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
    {
      schema: {
        params: campaignParams,
        response: {
          200: campaignResponse.extend({ companyName: z.string(), links: z.array(linkDetail) }),
        },
      },
    },
    async (request) => {
      const campaign = await repo.getCampaign(deps.db, request.params.id)
      if (!campaign) throw new CampaignNotFoundError(`campaign ${request.params.id} does not exist`)
      return campaign
    },
  )

  app.post<{ Body: SetupBody }>(
    '/',
    { schema: { body: setupBody, response: { 200: setupResponse, 201: setupResponse } } },
    async (request, reply) => {
      const { sources, ...campaign } = request.body
      // Parsed again as the service's own input, so the route can never hand over a shape the
      // service's schema would refuse (dates in order, defaults applied).
      const setup = campaignSetupSchema.parse({ ...campaign, sources: toSourceSetups(sources) })
      const result = await setUpCampaign(deps, setup)
      return reply.code(result.created ? 201 : 200).send(result)
    },
  )

  app.patch<{ Params: z.infer<typeof campaignParams>; Body: CampaignPatch }>(
    '/:id',
    {
      schema: {
        params: campaignParams,
        body: campaignPatchSchema,
        response: { 200: campaignResponse },
      },
    },
    async (request) => editCampaign(deps, request.params.id, request.body),
  )
}
