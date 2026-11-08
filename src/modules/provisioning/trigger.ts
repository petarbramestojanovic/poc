import type { RunTracker } from '../sync/engine.ts'
import { NothingToProvisionError } from './errors.ts'
import {
  provisionCampaign,
  type ProvisioningDeps,
  type ProvisioningResult,
  type ProvisionOptions,
} from './service.ts'
import type { ProvisioningTrigger } from './repo.ts'

// Provisioning started by something that must not wait for it: the Salesforce push that creates
// a campaign is answered at once, and the job runs behind it. Its outcome is the run record
// (external.provisioning_run) and a log line; nothing here throws. The tracker lets app.close()
// wait for a job in flight, like it does for a sync run or a send-now delivery.

export interface BackgroundDeps extends ProvisioningDeps {
  tracker?: RunTracker
}

export type ProvisionRun = (
  deps: ProvisioningDeps,
  campaignId: string,
  trigger: ProvisioningTrigger,
  options?: ProvisionOptions,
) => Promise<ProvisioningResult>

/** Starts the job and returns its settled promise, tracked. Never rejects. */
export function provisionInBackground(
  deps: BackgroundDeps,
  campaign: { id: string; name: string },
  trigger: ProvisioningTrigger,
  run: ProvisionRun = provisionCampaign,
): Promise<void> {
  const log = deps.log.child({ campaignId: campaign.id, trigger })
  const settled = run(deps, campaign.id, trigger).then(
    (result) => {
      log.info({ runId: result.runId, sources: result.sources }, 'campaign provisioned')
    },
    (error: unknown) => {
      // A campaign with nothing to create is not a failure: the CRM named no creative type.
      if (error instanceof NothingToProvisionError) {
        log.info({ reason: error.message }, 'nothing to provision')
        return
      }
      log.error({ err: error }, 'provisioning failed; the run record has the details')
    },
  )
  return deps.tracker ? deps.tracker.track(settled) : settled
}
