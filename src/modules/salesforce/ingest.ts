import { z } from 'zod'
import { setUpCampaign, type CampaignDeps } from '../campaigns/service.ts'
import { AppError } from '../../core/errors.ts'
import { toCampaignSetup } from './opportunity.ts'

// One delivery of the Salesforce webhook: every record goes through setUpCampaign on its own, so
// one bad record never holds back the others, and the answer says what happened to each. Sending
// the same records again is harmless — a push that changes nothing writes nothing — which is what
// makes a sender's retry safe without any record of deliveries already seen.

export const ingestSummarySchema = z.object({
  received: z.number(),
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  /** Records left alone on purpose (a campaign starting before INGEST_FROM): not errors. */
  skipped: z.array(
    z.object({
      record: z.number(),
      opportunityId: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  rejected: z.array(
    z.object({
      /** 0-based position in the delivery. */
      record: z.number(),
      opportunityId: z.string().nullable(),
      error: z.string(),
      message: z.string(),
    }),
  ),
  warnings: z.array(
    z.object({
      record: z.number(),
      opportunityId: z.string().nullable(),
      message: z.string(),
    }),
  ),
})
export type IngestSummary = z.infer<typeof ingestSummarySchema>

/**
 * A record the setup service refuses (another company, a platform clash …) is reported and
 * skipped. Anything else — the database gone, a bug — aborts the delivery with a 5xx, so the
 * sender retries it whole; the records already done are unchanged by the retry.
 */
export async function ingestOpportunities(
  deps: CampaignDeps,
  records: readonly unknown[],
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    received: records.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: [],
    rejected: [],
    warnings: [],
  }

  for (const [record, raw] of records.entries()) {
    const mapped = toCampaignSetup(raw)
    if (mapped.kind === 'skipped') {
      summary.skipped.push({ record, opportunityId: mapped.opportunityId, reason: mapped.reason })
      continue
    }
    if (mapped.kind === 'invalid') {
      summary.rejected.push({
        record,
        opportunityId: mapped.opportunityId,
        error: 'invalid_record',
        message: mapped.message,
      })
      continue
    }
    for (const message of mapped.warnings) {
      summary.warnings.push({ record, opportunityId: mapped.opportunityId, message })
    }
    try {
      const result = await setUpCampaign(deps, mapped.setup)
      if (result.created) summary.created += 1
      else if (result.updated) summary.updated += 1
      else summary.unchanged += 1
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error
      summary.rejected.push({
        record,
        opportunityId: mapped.opportunityId,
        error: error.code,
        message: error.message,
      })
    }
  }

  // Counts and ids only: the body names people and carries deal terms.
  deps.log.info(
    {
      received: summary.received,
      created: summary.created,
      updated: summary.updated,
      unchanged: summary.unchanged,
      skipped: summary.skipped.length,
      rejected: summary.rejected.map(({ record, opportunityId, error }) => ({
        record,
        opportunityId,
        error,
      })),
      warnings: summary.warnings.length,
    },
    'salesforce opportunities ingested',
  )
  return summary
}
