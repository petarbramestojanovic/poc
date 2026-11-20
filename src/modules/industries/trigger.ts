import { classifyCampaign, type ClassifyOutcome, type IndustryDeps } from './service.ts'

// Classification started by something that must not wait for it: the Salesforce push is answered
// at once, and the keyword table or the LLM decides behind it. Nothing here throws. The tracker
// lets app.close() wait for a classification in flight, like it does for provisioning.
//
// Log lines carry the campaign id, the industry, who decided it and the outcome: never the campaign
// or company name, the prompt or the model's answer.

export type ClassifyRun = (deps: IndustryDeps, campaignId: string) => Promise<ClassifyOutcome>

/** Starts the classification and returns its settled promise, tracked. Never rejects. */
export function classifyInBackground(
  deps: IndustryDeps,
  campaign: { id: string },
  run: ClassifyRun = classifyCampaign,
): Promise<void> {
  const log = deps.log.child({ campaignId: campaign.id })
  const settled = run(deps, campaign.id).then(
    ({ outcome, industry, via }) => {
      log.info({ outcome, industry, via }, 'campaign industry classified')
    },
    (error: unknown) => {
      if (deps.signal?.aborted) {
        log.info('campaign industry classification stopped by shutdown; the next push retries')
        return
      }
      // The error's class and code only: a database error's detail can quote the row it refused.
      log.error(
        {
          error: error instanceof Error ? error.name : 'unknown',
          code: (error as { code?: unknown } | null)?.code,
        },
        'campaign industry classification failed',
      )
    },
  )
  return deps.tracker ? deps.tracker.track(settled) : settled
}
