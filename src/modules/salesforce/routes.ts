import type { FastifyPluginAsync } from 'fastify'
import type { CampaignDeps } from '../campaigns/service.ts'
import { ingestCommittedOpps, ingestSummarySchema } from './ingest.ts'
import { committedOppsReportSchema, type CommittedOppsReport } from './report.ts'

// /inbound: where other systems push to us, behind a token of its own (app.ts), never the admin
// token. POST /inbound/campaigns takes the daily Salesforce report from another of our apps.
// 200 = the report was read (the summary lists any rows it skipped), 400 = the envelope is not the
// report, 401 = the token. A 5xx means try again: the same report sent twice changes nothing.

/** About 1 400 report rows; the service-wide 64 KiB would stop at about 90. */
export const INBOUND_BODY_LIMIT = 1024 * 1024

export const inboundRoutes: FastifyPluginAsync<{ deps: CampaignDeps }> = async (app, { deps }) => {
  app.post<{ Body: CommittedOppsReport }>(
    '/campaigns',
    {
      bodyLimit: INBOUND_BODY_LIMIT,
      schema: { body: committedOppsReportSchema, response: { 200: ingestSummarySchema } },
    },
    async (request) => ingestCommittedOpps(deps, request.body),
  )
}
