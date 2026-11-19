import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/core/log.ts'
import { NothingToProvisionError } from '../../src/modules/provisioning/errors.ts'
import type { ProvisioningResult } from '../../src/modules/provisioning/service.ts'
import {
  provisionInBackground,
  type BackgroundDeps,
  type ProvisionRun,
} from '../../src/modules/provisioning/trigger.ts'
import { createRunTracker } from '../../src/modules/sync/engine.ts'

// The job started by a push that must not wait for it: tracked, never throwing, whatever the job
// does. The job itself is tests/integration/provisioning.test.ts; here it is a stand-in.

const CAMPAIGN = { id: 'c0c0c0c0-0000-4000-8000-000000000003', name: 'DE2611 Tchibo Winter' }

const result: ProvisioningResult = {
  runId: 'r0r0r0r0-0000-4000-8000-000000000009',
  campaignId: CAMPAIGN.id,
  creatives: 1,
  sources: [],
  warnings: [],
}

function deps(): BackgroundDeps {
  // Only the logger and the tracker are touched here; the job is a stand-in.
  return { log: createLogger('silent'), tracker: createRunTracker() } as unknown as BackgroundDeps
}

describe('provisionInBackground', () => {
  it('runs the job for the campaign with the trigger it was given, and tracks it', async () => {
    const d = deps()
    const calls: unknown[] = []
    let release: () => void = () => undefined
    const run: ProvisionRun = (_deps, campaignId, trigger) => {
      calls.push([campaignId, trigger])
      return new Promise((resolve) => {
        release = () => {
          resolve(result)
        }
      })
    }

    const settled = provisionInBackground(d, CAMPAIGN, 'crm', run)
    expect(d.tracker?.size).toBe(1) // app.close() will wait for it
    release()
    await settled
    expect(calls).toEqual([[CAMPAIGN.id, 'crm']])
    expect(await d.tracker?.drain(1_000)).toBe(true) // nothing left for app.close() to wait for
  })

  it('never rejects: a platform failure is logged and recorded by the job, not thrown here', async () => {
    const d = deps()
    const run: ProvisionRun = () => Promise.reject(new Error('NEXD said no'))
    await expect(provisionInBackground(d, CAMPAIGN, 'crm', run)).resolves.toBeUndefined()
    expect(d.tracker?.size).toBe(0)
  })

  it('treats a campaign with nothing to create as no event', async () => {
    const d = deps()
    const run: ProvisionRun = () => Promise.reject(new NothingToProvisionError('no creative type'))
    await expect(provisionInBackground(d, CAMPAIGN, 'crm', run)).resolves.toBeUndefined()
  })

  it('works without a tracker too', async () => {
    const { tracker: _tracker, ...d } = deps()
    const run: ProvisionRun = () => Promise.resolve(result)
    await expect(provisionInBackground(d, CAMPAIGN, 'crm', run)).resolves.toBeUndefined()
  })
})
