import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { provisionCampaign, type ProvisioningDeps } from './service.ts'

// POST /campaigns/:id/provision — registered inside the /campaigns admin scope, so the bearer
// check runs first. Creates the campaign and its creatives on every platform that can, and
// writes the ids the others must be told. Runs to completion before answering: an operator's
// action, minutes at most; the CRM trigger (a later step) runs it in the background instead.

const params = z.object({ id: z.guid() })

const response = z.object({
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

export const provisioningRoutes: FastifyPluginAsync<{ deps: ProvisioningDeps }> = async (
  app,
  { deps },
) => {
  app.post<{ Params: z.infer<typeof params> }>(
    '/:id/provision',
    { schema: { params, response: { 200: response } } },
    async (request) => provisionCampaign(deps, request.params.id, 'manual'),
  )
}
