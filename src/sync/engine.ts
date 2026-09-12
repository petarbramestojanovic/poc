import type { Db } from '../db.ts'
import { daysInclusive, type DateWindow, type IsoDate } from '../dates.ts'
import type { HttpClient } from '../http/HttpClient.ts'
import type { Logger } from '../log.ts'
import { resolveSecret } from '../secrets.ts'
import { groupByDate, mergeRows } from './merge.ts'
import type { ConnectorRegistry } from './registry.ts'
import * as repo from './repo.ts'
import type { CanonicalDailyRow, SyncContext } from './types.ts'
import { diffDay, writeDay, type DayDiff } from './writer.ts'

// runSync is the single entry point for the nightly job, the trigger route and the CLI
// (RFC-003 §5). One run = one external.sync_run row; every written day is one transaction.

export interface SyncDeps {
  db: Db
  registry: ConnectorRegistry
  http: HttpClient
  log: Logger
  env?: NodeJS.ProcessEnv
}

export interface SyncRequest {
  linkId: string
  window: DateWindow
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
  warnings: string[]
  diff?: DayDiff[]
}

export class SyncError extends Error {
  override readonly name: string = 'SyncError'
}
export class LinkNotFoundError extends SyncError {
  override readonly name = 'LinkNotFoundError'
}
export class LinkDisabledError extends SyncError {
  override readonly name = 'LinkDisabledError'
}
export class TooSoonError extends SyncError {
  override readonly name = 'TooSoonError'
  readonly retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.retryAfterSeconds = retryAfterSeconds
  }
}
export class InvalidLinkConfigError extends SyncError {
  override readonly name = 'InvalidLinkConfigError'
}
export class UnknownTargetError extends SyncError {
  override readonly name = 'UnknownTargetError'
}
export class RowOutOfWindowError extends SyncError {
  override readonly name = 'RowOutOfWindowError'
}

export async function runSync(deps: SyncDeps, request: SyncRequest): Promise<SyncSummary> {
  const { db, registry, log } = deps
  const dryRun = request.dryRun ?? false
  daysInclusive(request.window.from, request.window.to) // validates the window

  const ctx = await repo.loadLinkContext(db, request.linkId)
  if (!ctx) throw new LinkNotFoundError(`link ${request.linkId} does not exist`)
  if (!ctx.link.enabled) throw new LinkDisabledError(`link ${request.linkId} is disabled`)
  if (!ctx.credential.enabled)
    throw new LinkDisabledError(`credential ${ctx.credential.name} is disabled`)

  const connector = registry.get(ctx.link.sourceId)
  const config = connector.describe().configSchema.safeParse(ctx.link.config)
  if (!config.success) {
    throw new InvalidLinkConfigError(
      `link ${request.linkId} config is invalid for ${connector.id}: ${config.error.message}`,
    )
  }

  if (request.trigger === 'manual' && !dryRun) {
    const elapsed = await repo.secondsSinceLastRun(db, ctx.link.id)
    if (elapsed !== undefined) {
      const remaining = Math.ceil(ctx.source.minManualIntervalSeconds - elapsed)
      if (remaining > 0) {
        throw new TooSoonError(
          `last run for link ${ctx.link.id} was ${Math.round(elapsed)} s ago; wait ${remaining} s`,
          remaining,
        )
      }
    }
  }

  const runId = await repo.insertRun(db, {
    linkId: ctx.link.id,
    trigger: request.trigger,
    triggeredBy: request.triggeredBy ?? null,
    window: request.window,
    dryRun,
  })
  const runLog = log.child({
    syncRunId: runId,
    linkId: ctx.link.id,
    source: ctx.link.sourceId,
    dryRun,
  })
  const warnings: string[] = []

  try {
    const syncContext: SyncContext = {
      source: ctx.source,
      link: ctx.link,
      entities: ctx.entities,
      eventMap: ctx.eventMap,
      credential: {
        id: ctx.credential.id,
        name: ctx.credential.name,
        secret: resolveSecret(ctx.credential.secretEnvVar, deps.env),
        accountScope: ctx.credential.accountScope,
      },
      window: request.window,
      http: deps.http,
      log: runLog,
    }

    runLog.info({ window: request.window, trigger: request.trigger }, 'sync started')
    const fetched = await connector.fetchWindow(syncContext)
    warnings.push(...fetched.warnings)
    await repo.insertRawPayloads(db, runId, fetched.raw)

    // The link's language is stamped on every row, whatever the connector put there.
    const rows = mergeRows(fetched.rows.map((row) => ({ ...row, language: ctx.link.language })))
    assertWithinWindow(rows, request.window)
    await assertKnownTargets(db, ctx.campaign.id, rows)
    const byDate = groupByDate(rows)

    const sliceFor = (date: IsoDate, dayRows: CanonicalDailyRow[]) => ({
      linkId: ctx.link.id,
      campaignId: ctx.campaign.id,
      source: ctx.link.sourceId,
      language: ctx.link.language,
      date,
      rows: dayRows,
    })

    if (dryRun) {
      const diff: DayDiff[] = []
      for (const [date, dayRows] of byDate) diff.push(await diffDay(db, sliceFor(date, dayRows)))
      await repo.finishRun(db, runId, { daysWritten: 0, rowsWritten: 0, warnings })
      runLog.info({ days: diff.length }, 'dry run finished')
      return { syncRunId: runId, dryRun, daysWritten: 0, rowsWritten: 0, warnings, diff }
    }

    let rowsWritten = 0
    let lastDay: IsoDate | null = null
    for (const [date, dayRows] of byDate) {
      const counts = await db.withTransaction((tx) =>
        writeDay(tx, { ...sliceFor(date, dayRows), syncRunId: runId }),
      )
      rowsWritten +=
        counts.inserted.advanced + counts.inserted.pageViews + counts.inserted.ctaClicks
      lastDay = date
      runLog.debug({ date, ...counts }, 'day replaced')
    }

    // The cursor moves only after every day's write has committed.
    await repo.upsertSyncState(db, ctx.link.id, {
      cursor: { lastWindow: request.window, lastRunId: runId },
      dataCompleteThrough: lastDay,
      deep: request.deep ?? false,
    })
    await repo.finishRun(db, runId, { daysWritten: byDate.size, rowsWritten, warnings })
    runLog.info(
      { daysWritten: byDate.size, rowsWritten, warnings: warnings.length },
      'sync succeeded',
    )
    return { syncRunId: runId, dryRun, daysWritten: byDate.size, rowsWritten, warnings }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    await repo.failRun(db, runId, message, warnings).catch((e: unknown) => {
      runLog.error({ err: e }, 'could not record run failure')
    })
    runLog.error({ err: error }, 'sync failed')
    throw error
  }
}

function assertWithinWindow(rows: readonly CanonicalDailyRow[], window: DateWindow): void {
  const outside = rows.filter((r) => r.date < window.from || r.date > window.to).map((r) => r.date)
  if (outside.length > 0) {
    throw new RowOutOfWindowError(
      `connector returned days outside ${window.from}..${window.to}: ${[...new Set(outside)].join(', ')}`,
    )
  }
}

/** Page and CTA ids must be defined for the campaign; a clear error beats an FK violation mid-write. */
async function assertKnownTargets(
  db: Db,
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
