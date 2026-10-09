import { limitDb, type LeaderLease } from '../../core/db.ts'
import { dayOfWeek, todayIn, type DateWindow } from '../../core/dates.ts'
import { redact } from '../../core/http/redact.ts'
import { runSync, type SyncDeps } from './engine.ts'
import { classifySyncError } from './errors.ts'
import * as repo from './repo.ts'
import { createRunMemo } from './types.ts'
import { lookbackWindow } from './windows.ts'

// The nightly pass (RFC-003 §5). Every eligible link is synced over its source's lookback ending
// yesterday, or over the deep lookback on Sundays. Links on different credentials run in
// parallel; links sharing a credential run one at a time, so a third-party token never sees
// concurrent requests from us. One failing link never stops the others.
// `npm run sync -- --all` runs exactly this; the 04:00 scheduler calls runNightlyTick.

/** Second key of the nightly leader lock; the first is LEADER_LOCK_NAMESPACE in db.ts. */
export const NIGHTLY_LEADER_LOCK_KEY = 1

/** The zone the 04:00 schedule, and "is tonight Sunday", are evaluated in. */
export const NIGHTLY_TIMEZONE = 'Europe/Zurich'

const DEEP_PULL_WEEKDAY = 0 // Sunday

export type SkipReason = 'campaign_archived' | 'campaign_not_started' | 'campaign_finished'

export interface PlannedLink {
  candidate: repo.NightlyCandidate
  window: DateWindow
}

export interface SkippedLink {
  candidate: repo.NightlyCandidate
  reason: SkipReason
}

export interface NightlyPlan {
  deep: boolean
  planned: PlannedLink[]
  skipped: SkippedLink[]
}

export function isDeepPullNight(now: Date): boolean {
  return dayOfWeek(todayIn(NIGHTLY_TIMEZONE, now)) === DEEP_PULL_WEEKDAY
}

/**
 * Pure: which links tonight's pass syncs, and over which window. A campaign is skipped only when
 * nothing it delivered could fall inside a window we would query. Unknown dates never skip.
 */
export function planNightlyPass(
  candidates: readonly repo.NightlyCandidate[],
  now: Date,
): NightlyPlan {
  const deep = isDeepPullNight(now)
  const plan: NightlyPlan = { deep, planned: [], skipped: [] }
  for (const candidate of candidates) {
    const window = lookbackWindow(candidate.source, { deep, now })
    const deepWindow = lookbackWindow(candidate.source, { deep: true, now })
    const reason = skipReason(candidate, window, deepWindow)
    if (reason) plan.skipped.push({ candidate, reason })
    else plan.planned.push({ candidate, window })
  }
  return plan
}

function skipReason(
  candidate: repo.NightlyCandidate,
  window: DateWindow,
  deepWindow: DateWindow,
): SkipReason | undefined {
  if (candidate.campaignStatus === 'archived') return 'campaign_archived'
  // Starts after the newest complete day: the source cannot have anything for it yet.
  if (candidate.startsOn !== null && candidate.startsOn > window.to) return 'campaign_not_started'
  // Ended before even the deep lookback begins: no pull we run could still catch a restatement.
  if (candidate.endsOn !== null && candidate.endsOn < deepWindow.from) return 'campaign_finished'
  return undefined
}

export type LinkOutcome =
  | {
      status: 'succeeded'
      syncRunId: string
      daysWritten: number
      rowsWritten: number
      warnings: number
    }
  | { status: 'failed'; code: string; retryable: boolean; message: string }
  | { status: 'not_run'; reason: 'aborted' | 'leader_lock_lost' }

export interface LinkResult {
  linkId: string
  sourceId: string
  campaignName: string
  window: DateWindow
  outcome: LinkOutcome
}

export interface NightlyPassSummary {
  deep: boolean
  results: LinkResult[]
  skipped: SkippedLink[]
  durationMs: number
}

export interface NightlyPassOptions {
  /** The leader lease, re-checked before every link because each run writes irreversibly. */
  lease?: LeaderLease
  /** Restricts the pass to these links (targeted re-runs, tests). */
  onlyLinkIds?: readonly string[]
}

export async function runNightlyPass(
  deps: SyncDeps,
  options: NightlyPassOptions = {},
): Promise<NightlyPassSummary> {
  const started = Date.now()
  const now = (deps.now ?? (() => new Date()))()
  const candidates = await repo.loadNightlyCandidates(limitDb(deps.db, deps.limiter))
  const only = options.onlyLinkIds ? new Set(options.onlyLinkIds) : undefined
  const plan = planNightlyPass(
    only ? candidates.filter((c) => only.has(c.linkId)) : candidates,
    now,
  )

  // Losing the lease stops the pass: in-flight runs stop before their next day, queued links
  // never start.
  const passControl = new AbortController()
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, passControl.signal])
    : passControl.signal
  // One memo for the pass: a response identical across links (Zeus's unfiltered tracker report)
  // is fetched once per credential and window.
  const runDeps: SyncDeps = { ...deps, signal, memo: createRunMemo() }

  const lanes = new Map<string, { index: number; link: PlannedLink }[]>()
  for (const [index, link] of plan.planned.entries()) {
    const lane = lanes.get(link.candidate.credentialId) ?? []
    lane.push({ index, link })
    lanes.set(link.candidate.credentialId, lane)
  }

  const collected: { index: number; result: LinkResult }[] = []
  await Promise.all(
    [...lanes.values()].map(async (lane) => {
      for (const { index, link } of lane) {
        const result = await runLink(runDeps, link, plan.deep, options.lease, passControl)
        collected.push({ index, result })
      }
    }),
  )

  const summary: NightlyPassSummary = {
    deep: plan.deep,
    results: collected.sort((a, b) => a.index - b.index).map((entry) => entry.result),
    skipped: plan.skipped,
    durationMs: Date.now() - started,
  }
  const count = (status: LinkOutcome['status']) =>
    summary.results.filter((r) => r.outcome.status === status).length
  deps.log.info(
    {
      deep: summary.deep,
      succeeded: count('succeeded'),
      failed: count('failed'),
      notRun: count('not_run'),
      skipped: summary.skipped.length,
      durationMs: summary.durationMs,
    },
    'nightly pass finished',
  )
  return summary
}

async function runLink(
  deps: SyncDeps,
  link: PlannedLink,
  deep: boolean,
  lease: LeaderLease | undefined,
  passControl: AbortController,
): Promise<LinkResult> {
  const { candidate, window } = link
  const result = (outcome: LinkOutcome): LinkResult => ({
    linkId: candidate.linkId,
    sourceId: candidate.sourceId,
    campaignName: candidate.campaignName,
    window,
    outcome,
  })

  if (passControl.signal.aborted) return result({ status: 'not_run', reason: 'leader_lock_lost' })
  if (deps.signal?.aborted) return result({ status: 'not_run', reason: 'aborted' })
  if (lease) {
    try {
      await lease.assertHeld()
    } catch (error) {
      deps.log.error({ err: error }, 'nightly leader lock lost; stopping the pass')
      passControl.abort(error)
      return result({ status: 'not_run', reason: 'leader_lock_lost' })
    }
  }

  try {
    const summary = await runSync(deps, {
      linkId: candidate.linkId,
      window,
      trigger: 'cron',
      deep,
      triggeredBy: null,
    })
    return result({
      status: 'succeeded',
      syncRunId: summary.syncRunId,
      daysWritten: summary.daysWritten,
      rowsWritten: summary.rowsWritten,
      warnings: summary.warnings.length,
    })
  } catch (error) {
    const { code, retryable } = classifySyncError(error)
    const message = redact(error instanceof Error ? error.message : String(error))
    return result({ status: 'failed', code, retryable, message })
  }
}

export interface NightlyTickResult {
  acquired: boolean
  pass?: NightlyPassSummary
}

/** One scheduler tick: the pass runs only in the process that wins the nightly leader lock. */
export async function runNightlyTick(
  deps: SyncDeps,
  options: Omit<NightlyPassOptions, 'lease'> = {},
): Promise<NightlyTickResult> {
  const locked = await deps.db.withAdvisoryLock(NIGHTLY_LEADER_LOCK_KEY, (lease) =>
    runNightlyPass(deps, { ...options, lease }),
  )
  if (!locked.acquired) {
    deps.log.info('nightly pass not run: another process holds the leader lock')
    return { acquired: false }
  }
  return locked.result ? { acquired: true, pass: locked.result } : { acquired: true }
}
