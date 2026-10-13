import type { FastifyPluginAsync } from 'fastify'
import type { CampaignDeps } from '../campaigns/service.ts'
import { ingestOpportunities, ingestSummarySchema } from './ingest.ts'
import { opportunityDeliverySchema, recordsOf, type OpportunityDelivery } from './opportunity.ts'

// /inbound: where other systems push to us, behind a token of its own (app.ts), never the admin
// token. POST /inbound/salesforce/opportunities is Salesforce's webhook: one Opportunity record or
// a list of them. 200 = the delivery was read (the summary lists any records it skipped), 400 = the
// body is neither, 401 = the token. A 5xx means try again: the same records sent twice change nothing.

/** MAX_RECORDS full records; the service-wide 64 KiB would stop at about six. */
export const INBOUND_BODY_LIMIT = 4 * 1024 * 1024

export const inboundRoutes: FastifyPluginAsync<{ deps: CampaignDeps }> = async (app, { deps }) => {
  app.post<{ Body: OpportunityDelivery }>(
    '/salesforce/opportunities',
    {
      bodyLimit: INBOUND_BODY_LIMIT,
      schema: { body: opportunityDeliverySchema, response: { 200: ingestSummarySchema } },
    },
    async (request) => ingestOpportunities(deps, recordsOf(request.body)),
  )
}
