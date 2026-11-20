import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Queryable } from '../../core/db.ts'
import { INDUSTRY_SOURCES } from './map.ts'
import * as repo from './repo.ts'
import { setIndustryByHand } from './service.ts'

// Two admin routes, each registered inside its admin scope in app.ts, so the bearer check runs
// first:
//
//   PUT /campaigns/:id/industry   a person sets a campaign's industry (source 'manual'), or clears
//                                 it with null. The classifier never overwrites a hand-set value.
//                                 400 unknown_industry for a name not in GET /industries.
//   GET /industries               the names a campaign can have, with their definitions.

export interface IndustryRouteDeps {
  db: Queryable
}

const campaignParams = z.object({ id: z.guid() })
const industryBody = z.strictObject({ industry: z.string().trim().min(1).nullable() })
const assignmentResponse = z.object({
  id: z.guid(),
  industry: z.string().nullable(),
  industrySource: z.enum(INDUSTRY_SOURCES).nullable(),
})

/** Under /campaigns. */
export const campaignIndustryRoutes: FastifyPluginAsync<{ deps: IndustryRouteDeps }> = async (
  app,
  { deps },
) => {
  app.put<{ Params: z.infer<typeof campaignParams>; Body: z.infer<typeof industryBody> }>(
    '/:id/industry',
    {
      schema: { params: campaignParams, body: industryBody, response: { 200: assignmentResponse } },
    },
    async (request) => setIndustryByHand(deps.db, request.params.id, request.body.industry),
  )
}

/** Under /industries. */
export const industryRoutes: FastifyPluginAsync<{ deps: IndustryRouteDeps }> = async (
  app,
  { deps },
) => {
  app.get(
    '/',
    {
      schema: {
        response: { 200: z.array(z.object({ name: z.string(), definition: z.string() })) },
      },
    },
    async () => repo.listIndustries(deps.db),
  )
}
