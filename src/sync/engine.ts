import { limitDb, type Db, type Queryable } from '../db.ts'
import { assertIsoDate, daysInclusive, eachDay, type DateWindow, type IsoDate } from '../dates.ts'
import type { HttpClient } from '../http/HttpClient.ts'
import { redact } from '../http/redact.ts'
import type { Limiter } from '../limiter.ts'
import type { Logger } from '../log.ts'
import { InvalidSecretPointerError, MissingSecretError, resolveSecret } from '../secrets.ts'
import {
  classifySyncError,
  CredentialUnavailableError,
  InvalidLinkConfigError,
  InvalidRowDateError,
  LinkDisabledError,
  LinkNotFoundError,
  RowOutOfWindowError,
  SyncAbortedError,
  SyncError,
  UnknownTargetError,
} from './errors.ts'
import { groupByDate, mergeRows } from './merge.ts'
import { assertRegistryMatchesSources, type ConnectorRegistry } from './registry.ts'
import * as repo from './repo.ts'
import { createRunMemo, type CanonicalDailyRow, type RunMemo, type SyncContext } from './types.ts'
import { lookbackWindow } from './windows.ts'
import { diffDay, writeDay, type DayDiff } from './writer.ts'

export * from './errors.ts'

// runSync is the single entry point for the nightly job, the trigger route and the CLI
// (RFC-003 §5). One run = one external.sync_run row; every written day is one transaction.

/** RFC-002 §14.1: sync work never holds more than 3 of the pool's 10 connections. */
export const SYNC_MAX_CONNECTIONS = 3

export interface SyncDeps {
  db: Db
  registry: ConnectorRegistry
  http: HttpClient
  log: Logger
  /**
   * Caps this process's sync share of the pool. Share ONE limiter (createLimiter(SYNC_MAX_CONNECTIONS))
   * across every run in the process — a limiter per run caps nothing.
   */
  limiter: Limiter
  env?: NodeJS.ProcessEnv
  /** Process shutdown signal: checked before each day's transaction and passed to every request. */
  signal?: AbortSignal
  /** Lets shutdown wait for in-flight runs to finish or abort cleanly. */
  tracker?: RunTracker
  /** Shared across the links of one scheduler pass; a fresh memo per run otherwise. */
  memo?: RunMemo
  /** Clock for the default lookback window and the nightly pass. Injectable for tests. */
  now?: () => Date
}

export interface SyncRequest {
  linkId: string
  /**
   * Days to pull. Omitted = the source's lookback (the deep lookback when `deep`) ending at
   * yesterday in the source's day zone: the same window the nightly pass uses.
   */
  window?: DateWindow
  trigger: repo.SyncTrigger
  dryRun?: boolean
  triggeredBy?: string | null
  /** Marks external.sync_state.last_deep_sync_at on success (weekly deep re-pull). */
  deep?: boolean
}

export interface SyncSummary {
  syncRunId: string
  dryRun: boolean
  daysWritten: number
  rowsWritten: number
  rowsDeleted: number
  httpCalls: number
  durationMs: number
  warnings: string[]
  diff?: DayDiff[]
}

export interface RunTracker {
  track<T>(run: Promise<T>): Promise<T>
  /** Resolves true when every tracked run settled, false when the timeout came first. */
  drain(timeoutMs: number): Promise<boolean>
  readonly size: number
}

export function createRunTracker(): RunTracker {
  const active = new Set<Promise<void>>()
  return {
    track(run) {
      const settled = run.then(
        () => undefined,
        () => undefined,
      )
      active.add(settled)
      void settled.then(() => active.delete(settled))
      return run
    },
    async drain(timeoutMs) {
      if (active.size === 0) return true
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false)
        }, timeoutMs)
        timer.unref()
      })
      const all = Promise.all([...active]).then(() => true as const)
      const result = await Promise.race([all, timedOut])
      clearTimeout(timer)
      return result
    },
    get size() {
      return active.size
    },
  }
}

export function runSync(deps: SyncDeps, request: SyncRequest): Promise<SyncSummary> {
  const run = execute(deps, request)
  return deps.tracker ? deps.tracker.track(run) : run
}

/** Boot check: the connector registry matches the enabled platform sources in the database. */
export async function verifyRegistryAgainstSources(
  db: Queryable,
  registry: ConnectorRegistry,
): Promise<void> {
  assertRegistryMatchesSources(registry, await repo.loadEnabledPlatformSourceIds(db))
}

const NEVER_ABORTED = new AbortController().signal
const currentTime = (): Date => new Date()

async function execute(deps: SyncDeps, request: SyncRequest): Promise<SyncSummary> {
  const { registry, log } = deps
  const db = limitDb(deps.db, deps.limiter)
  const signal = deps.signal ?? NEVER_ABORTED
  const aborted = (): boolean => signal.aborted
  const dryRun = request.dryRun ?? false
  const started = Date.now()

  if (request.window) {
    assertIsoDate(request.window.from)
    assertIsoDate(request.window.to)
    daysInclusive(request.window.from, request.window.to) // rejects an inverted window
  }
  if (signal.aborted) throw new SyncAbortedError('shutdown in progress; run not started')

  const ctx = await repo.loadLinkContext(db, request.linkId)
  if (!ctx) throw new LinkNotFoundError(`link ${request.linkId} does not exist`)
  if (!ctx.link.enabled) throw new LinkDisabledError(`link ${request.linkId} is disabled`)
  if (!ctx.credential.enabled) {
    throw new LinkDisabledError(`credential ${ctx.credential.name} is disabled`)
  }

  const connector = registry.get(ctx.link.sourceId)
  const parsedConfig = connector.describe().configSchema.safeParse(ctx.link.config)
  if (!parsedConfig.success) {
    const issues = parsedConfig.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    }))
    throw new InvalidLinkConfigError(
      `link ${request.linkId} config is invalid for ${connector.id}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      issues,
    )
  }

  const window =
    request.window ??
    lookbackWindow(ctx.source, { deep: request.deep ?? false, now: (deps.now ?? currentTime)() })

  const runId = await repo.openRun(
    db,
    {
      linkId: ctx.link.id,
      trigger: request.trigger,
      triggeredBy: request.triggeredBy ?? null,
      window,
      dryRun,
    },
    request.trigger === 'manual' ? ctx.source.minManualIntervalSeconds : null,
  )
  const runLog = log.child({
    syncRunId: runId,
    linkId: ctx.link.id,
    source: ctx.link.sourceId,
    dryRun,
  })
  const warnings: string[] = []
  let httpCalls = 0

  try {
    let secret: string
    try {
      secret = resolveSecret(ctx.credential.secretEnvVar, deps.env)
    } catch (error) {
      if (error instanceof MissingSecretError || error instanceof InvalidSecretPointerError) {
        throw new CredentialUnavailableError(
          `credential ${ctx.credential.name}: ${error.message}`,
          {
            cause: error,
          },
        )
      }
      throw error
    }

    const syncContext: SyncContext = {
      source: ctx.source,
      link: ctx.link,
      config: parsedConfig.data,
      entities: ctx.entities,
      eventMap: ctx.eventMap,
      credential: {
        id: ctx.credential.id,
        name: ctx.credential.name,
        secret,
        accountScope: ctx.credential.accountScope,
      },
      window,
      http: deps.http,
      log: runLog,
      signal,
      // Persisted as each response arrives, so a run that fails halfway keeps its payloads.
      capture: async (raw) => {
        httpCalls++
        await repo.insertRawPayloads(db, runId, [raw])
      },
      memo: deps.memo ?? createRunMemo(),
    }

    runLog.info({ window, trigger: request.trigger }, 'sync started')
    const fetched = await connector.fetchWindow(syncContext)
    warnings.push(...fetched.warnings)

    // The link's language is stamped on every row, whatever the connector put there.
    const rows = mergeRows(
      fetched.rows.map((row) => ({ ...row, language: ctx.link.language })),
      (warning) => warnings.push(warning),
    )
    assertValidDates(rows)
    const covered = fetched.covered
    assertWithinWindow(rows, covered, window)
    await assertKnownTargets(db, ctx.campaign.id, rows)

    const byDate = groupByDate(rows)
    // Every day the connector vouches for is replaced — including days it returned nothing for,
    // so a day the source retracted is cleared instead of keeping last week's numbers forever.
    const days = covered ? eachDay(covered.from, covered.to) : []
    const sliceFor = (date: IsoDate) => ({
      linkId: ctx.link.id,
      campaignId: ctx.campaign.id,
      source: ctx.link.sourceId,
      language: ctx.link.language,
      date,
      rows: byDate.get(date) ?? [],
    })

    if (dryRun) {
      const diff: DayDiff[] = []
      for (const date of days) diff.push(await diffDay(db, sliceFor(date)))
      await repo.finishRun(db, runId, { daysWritten: 0, rowsWritten: 0, warnings })
      const durationMs = Date.now() - started
      runLog.info({ days: diff.length, httpCalls, durationMs }, 'dry run finished')
      return {
        syncRunId: runId,
        dryRun,
        daysWritten: 0,
        rowsWritten: 0,
        rowsDeleted: 0,
        httpCalls,
        durationMs,
        warnings,
        diff,
      }
    }

    let rowsWritten = 0
    let rowsDeleted = 0
    let daysWritten = 0
    for (const date of days) {
      if (aborted()) {
        throw new SyncAbortedError(
          `shutdown before writing ${date}; ${daysWritten} day(s) already committed, sync_state not advanced`,
        )
      }
      const counts = await db.withTransaction((tx) =>
        writeDay(tx, { ...sliceFor(date), syncRunId: runId }),
      )
      rowsWritten +=
        counts.inserted.advanced + counts.inserted.pageViews + counts.inserted.ctaClicks
      rowsDeleted += counts.deleted.advanced + counts.deleted.pageViews + counts.deleted.ctaClicks
      daysWritten++
      runLog.debug({ date, ...counts }, 'day replaced')
    }

    // The cursor, the unmapped queue and the run outcome commit together, and only after every
    // day's analytics write has committed.
    await db.withTransaction(async (tx) => {
      await repo.upsertUnmapped(tx, ctx.link.id, unmappedTotals(rows))
      await repo.upsertSyncState(tx, ctx.link.id, {
        cursor: { lastWindow: covered ?? window, lastRunId: runId },
        dataCompleteThrough: covered?.to ?? null,
        deep: request.deep ?? false,
      })
      await repo.finishRun(tx, runId, { daysWritten, rowsWritten, warnings })
    })
    const durationMs = Date.now() - started
    runLog.info(
      { daysWritten, rowsWritten, rowsDeleted, httpCalls, durationMs, warnings: warnings.length },
      'sync succeeded',
    )
    return {
      syncRunId: runId,
      dryRun,
      daysWritten,
      rowsWritten,
      rowsDeleted,
      httpCalls,
      durationMs,
      warnings,
    }
  } catch (caught) {
    const error =
      aborted() && !(caught instanceof SyncError)
        ? new SyncAbortedError('sync aborted by shutdown', { cause: caught })
        : caught
    const durationMs = Date.now() - started
    // Recorded through the unlimited pool: a saturated limiter must not lose the failure record.
    await repo.failRun(deps.db, runId, failureMessage(error), warnings).catch((e: unknown) => {
      runLog.error({ err: e }, 'could not record run failure')
    })
    runLog.error({ err: error, ...classifySyncError(error), httpCalls, durationMs }, 'sync failed')
    throw error
  }
}

/** Stored in sync_run.error: name, machine code, message and the cause's code — always redacted. */
function failureMessage(error: unknown): string {
  const { code } = classifySyncError(error)
  if (!(error instanceof Error)) return redact(`[${code}] ${String(error)}`)
  const cause: unknown = error.cause
  const causeCode = (cause as { code?: unknown } | null | undefined)?.code
  const causeText =
    cause instanceof Error
      ? ` (cause: ${cause.name}${typeof causeCode === 'string' ? ` ${causeCode}` : ''}: ${cause.message})`
      : ''
  return redact(`${error.name} [${code}]: ${error.message}${causeText}`)
}

function assertValidDates(rows: readonly CanonicalDailyRow[]): void {
  for (const row of rows) {
    try {
      assertIsoDate(row.date)
    } catch {
      throw new InvalidRowDateError(
        `connector returned an invalid day: ${JSON.stringify(row.date)}`,
      )
    }
  }
}

function assertWithinWindow(
  rows: readonly CanonicalDailyRow[],
  covered: DateWindow | null,
  requested: DateWindow,
): void {
  if (covered && (covered.from < requested.from || covered.to > requested.to)) {
    throw new RowOutOfWindowError(
      `connector claims coverage ${covered.from}..${covered.to} outside the requested ${requested.from}..${requested.to}`,
    )
  }
  const outside = rows
    .filter((r) => !covered || r.date < covered.from || r.date > covered.to)
    .map((r) => r.date)
  if (outside.length > 0) {
    const range = covered ? `${covered.from}..${covered.to}` : '(nothing covered)'
    throw new RowOutOfWindowError(
      `connector returned days outside its covered window ${range}: ${[...new Set(outside)].join(', ')}`,
    )
  }
}

/** Page and CTA ids must be defined for the campaign; a clear error beats an FK violation mid-write. */
async function assertKnownTargets(
  db: Queryable,
  campaignId: string,
  rows: readonly CanonicalDailyRow[],
): Promise<void> {
  const targets = await repo.loadCampaignTargets(db, campaignId)
  const missingPages = new Set(
    rows.flatMap((r) => r.pageViews.map((p) => p.pageId)).filter((id) => !targets.pages.has(id)),
  )
  const missingCtas = new Set(
    rows.flatMap((r) => r.ctaClicks.map((c) => c.ctaId)).filter((id) => !targets.ctas.has(id)),
  )
  if (missingPages.size > 0 || missingCtas.size > 0) {
    const parts: string[] = []
    if (missingPages.size > 0) parts.push(`pages: ${[...missingPages].join(', ')}`)
    if (missingCtas.size > 0) parts.push(`ctas: ${[...missingCtas].join(', ')}`)
    throw new UnknownTargetError(
      `rows reference ids not defined for campaign ${campaignId} (${parts.join('; ')})`,
    )
  }
}

function unmappedTotals(rows: readonly CanonicalDailyRow[]): repo.UnmappedTotal[] {
  const totals = new Map<string, repo.UnmappedTotal>()
  for (const row of rows) {
    for (const [eventName, count] of row.unmapped) {
      const entry = totals.get(eventName)
      if (entry) {
        entry.totalCount += count
        if (row.date < entry.firstSeen) entry.firstSeen = row.date
        if (row.date > entry.lastSeen) entry.lastSeen = row.date
      } else {
        totals.set(eventName, {
          eventName,
          firstSeen: row.date,
          lastSeen: row.date,
          totalCount: count,
        })
      }
    }
  }
  return [...totals.values()]
}
