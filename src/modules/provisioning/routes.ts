import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { addCreative } from '../campaigns/service.ts'
import { provisionCampaign, type ProvisioningDeps } from './service.ts'

// Registered inside the /campaigns admin scope, so the bearer check runs first.
//
// POST /campaigns/:id/provision   creates the campaign and its creatives on every platform that
//                                 can, and writes the ids the others must be told.
// POST /campaigns/:id/creatives   one more creative of ours, created on the platforms at once:
//                                 the one way a creative is added after the CRM's creative types.
//
// Both run to completion before answering: an operator's action, minutes at most; the CRM trigger
// (a later step) runs the job in the background instead. A creative whose provisioning failed
// stays (never deleted) and is finished by the next POST /provision, which resumes.

const params = z.object({ id: z.guid() })

const runResponse = z.object({
  runId: z.guid(),
  campaignId: z.guid(),
  creatives: z.number().int(),
  sources: z.array(
    z.object({
      source: z.string(),
      resourcesAdded: z.number().int(),
      entitiesAdded: z.number().int(),
    }),
  ),
  warnings: z.array(z.string()),
})

const newCreativeBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  /** The creative type as the CRM names it ('Swipe Card'); left out = not known. */
  type: z.string().trim().min(1).max(200).optional(),
})

const creativeResponse = z.object({
  id: z.guid(),
  tag: z.string(),
  type: z.string().nullable(),
  name: z.string(),
  createdAt: z.date(),
})

export const provisioningRoutes: FastifyPluginAsync<{ deps: ProvisioningDeps }> = async (
  app,
  { deps },
) => {
  app.post<{ Params: z.infer<typeof params> }>(
    '/:id/provision',
    { schema: { params, response: { 200: runResponse } } },
    async (request) => provisionCampaign(deps, request.params.id, 'manual'),
  )

  app.post<{ Params: z.infer<typeof params>; Body: z.infer<typeof newCreativeBody> }>(
    '/:id/creatives',
    {
      schema: {
        params,
        body: newCreativeBody,
        response: { 201: z.object({ creative: creativeResponse, run: runResponse }) },
      },
    },
    async (request, reply) => {
      const creative = await addCreative(deps.campaigns, request.params.id, request.body)
      const run = await provisionCampaign(deps, request.params.id, 'creative', {
        creativeIds: [creative.id],
      })
      return reply.code(201).send({ creative, run })
    },
  )
}
