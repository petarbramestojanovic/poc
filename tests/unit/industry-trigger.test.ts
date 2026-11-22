import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/core/log.ts'
import type { ClassifyOutcome, IndustryDeps } from '../../src/modules/industries/service.ts'
import { classifyInBackground, type ClassifyRun } from '../../src/modules/industries/trigger.ts'
import { createRunTracker } from '../../src/modules/sync/engine.ts'

// The classification a Salesforce push starts and does not wait for: tracked, never throwing,
// logging ids and outcomes only. The classification itself is tests/integration/industries.test.ts;
// here it is a stand-in.

const CAMPAIGN = { id: 'c0c0c0c0-0000-4000-8000-000000000005' }

const set: ClassifyOutcome = {
  campaignId: CAMPAIGN.id,
  outcome: 'set',
  industry: 'Retail',
  via: 'llm',
}

function deps(log = createLogger('silent')): IndustryDeps {
  // Only the logger and the tracker are touched here; the classification is a stand-in.
  return { log, tracker: createRunTracker() } as unknown as IndustryDeps
}

describe('classifyInBackground', () => {
  it('classifies the campaign and tracks it until it settles', async () => {
    const d = deps()
    const calls: string[] = []
    let release: () => void = () => undefined
    const run: ClassifyRun = (_deps, campaignId) => {
      calls.push(campaignId)
      return new Promise((resolve) => {
        release = () => {
          resolve(set)
        }
      })
    }

    const settled = classifyInBackground(d, CAMPAIGN, run)
    expect(d.tracker?.size).toBe(1) // app.close() will wait for it
    release()
    await settled
    expect(calls).toEqual([CAMPAIGN.id])
    expect(await d.tracker?.drain(1_000)).toBe(true)
  })

  it('never rejects: a failure is logged, not thrown', async () => {
    const d = deps()
    const run: ClassifyRun = () => Promise.reject(new Error('database gone'))
    await expect(classifyInBackground(d, CAMPAIGN, run)).resolves.toBeUndefined()
    expect(d.tracker?.size).toBe(0)
  })

  it('works without a tracker too', async () => {
    const { tracker: _tracker, ...d } = deps()
    const run: ClassifyRun = () => Promise.resolve(set)
    await expect(classifyInBackground(d, CAMPAIGN, run)).resolves.toBeUndefined()
  })

  it('logs the campaign id, the industry, who decided it and the outcome, nothing else', async () => {
    const lines: string[] = []
    const d = deps(pino({ level: 'info' }, { write: (line: string) => lines.push(line) }))
    await classifyInBackground(d, CAMPAIGN, () => Promise.resolve(set))

    const [line] = lines.map((text) => JSON.parse(text) as Record<string, unknown>)
    expect(line).toMatchObject({
      campaignId: CAMPAIGN.id,
      outcome: 'set',
      industry: 'Retail',
      via: 'llm',
      msg: 'campaign industry classified',
    })
    const { level: _l, time: _t, pid: _p, hostname: _h, msg: _m, ...fields } = line ?? {}
    expect(Object.keys(fields).sort()).toEqual(['campaignId', 'industry', 'outcome', 'via'])
  })

  it('logs a failure by its class and code, never its message', async () => {
    const lines: string[] = []
    const d = deps(pino({ level: 'info' }, { write: (line: string) => lines.push(line) }))
    const refused = Object.assign(new Error('Key (name)=(DE2611 Tchibo Winter) refused'), {
      code: '23503',
    })
    await classifyInBackground(d, CAMPAIGN, () => Promise.reject(refused))

    const logged = lines.join('\n')
    expect(logged).toContain('"code":"23503"')
    expect(logged).toContain('classification failed')
    expect(logged).not.toContain('Tchibo')
  })
})
