import { z } from 'zod'
import { setUpCampaign, type CampaignDeps } from '../campaigns/service.ts'
import { AppError } from '../../core/errors.ts'
import { toCampaignSetup, type CommittedOppsReport } from './report.ts'

// One delivery of the daily report: every row goes through setUpCampaign on its own, so one bad
// row never holds back the others, and the answer says what happened to each. Sending the same
// report again is harmless — a push that changes nothing writes nothing — which is what makes a
// sender's retry safe without any record of reports already seen.

export const ingestSummarySchema = z.object({
  report: z.object({ name: z.string().nullable(), asOf: z.string().nullable() }),
  received: z.number(),
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  rejected: z.array(
    z.object({
      /** 0-based position in `campaigns`. */
      row: z.number(),
      opportunityId: z.string().nullable(),
      error: z.string(),
      message: z.string(),
    }),
  ),
  warnings: z.array(
    z.object({
      row: z.number().nullable(),
      opportunityId: z.string().nullable(),
      message: z.string(),
    }),
  ),
})
export type IngestSummary = z.infer<typeof ingestSummarySchema>

/**
 * A row the setup service refuses (another company, a platform clash …) is reported and skipped.
 * Anything else — the database gone, a bug — aborts the delivery with a 5xx, so the sender retries
 * it whole; the rows already done are unchanged by the retry.
 */
export async function ingestCommittedOpps(
  deps: CampaignDeps,
  report: CommittedOppsReport,
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    report: { name: report.report_name ?? null, asOf: report.report_as_of ?? null },
    received: report.campaigns.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    rejected: [],
    warnings: [],
  }
  if (report.unmapped_columns.length > 0) {
    summary.warnings.push({
      row: null,
      opportunityId: null,
      message: `columns the sender could not map (has the report changed?): ${report.unmapped_columns.join(', ')}`,
    })
  }

  for (const [row, raw] of report.campaigns.entries()) {
    const mapped = toCampaignSetup(raw)
    if (!mapped.ok) {
      summary.rejected.push({
        row,
        opportunityId: mapped.opportunityId,
        error: 'invalid_row',
        message: mapped.message,
      })
      continue
    }
    for (const message of mapped.warnings) {
      summary.warnings.push({ row, opportunityId: mapped.opportunityId, message })
    }
    try {
      const result = await setUpCampaign(deps, mapped.setup)
      if (result.created) summary.created += 1
      else if (result.updated) summary.updated += 1
      else summary.unchanged += 1
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error
      summary.rejected.push({
        row,
        opportunityId: mapped.opportunityId,
        error: error.code,
        message: error.message,
      })
    }
  }

  // Counts and ids only: the body names people and carries deal terms.
  deps.log.info(
    {
      reportAsOf: summary.report.asOf,
      received: summary.received,
      created: summary.created,
      updated: summary.updated,
      unchanged: summary.unchanged,
      rejected: summary.rejected.map(({ row, opportunityId, error }) => ({
        row,
        opportunityId,
        error,
      })),
      warnings: summary.warnings.length,
    },
    'salesforce report ingested',
  )
  return summary
}
