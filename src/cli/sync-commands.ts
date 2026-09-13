import { redact } from '../http/redact.ts'
import type { SyncRuntime } from '../runtime.ts'
import { resolveSecret } from '../secrets.ts'
import type { PixelSummary } from '../sync/connectors/zeus/connector.ts'
import { classifySyncError, runSync, type SyncDeps, type SyncSummary } from '../sync/engine.ts'
import { runNightlyTick, type LinkOutcome, type NightlyPassSummary } from '../sync/nightly.ts'
import * as repo from '../sync/repo.ts'
import { METRIC_IDS, type ConnectionContext, type SourceConnector } from '../sync/types.ts'
import type { DayDiff } from '../sync/writer.ts'
import { USAGE, type SyncCommand } from './args.ts'

// What each `npm run sync` mode does. Every command goes through the same engine, repository and
// connectors as the service. The formatters at the bottom are pure and exported for tests.

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export interface CommandContext {
  runtime: SyncRuntime
  signal: AbortSignal
  io: CliIo
  /** Where credential pointers resolve. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

/** A failure the operator can act on: printed as-is, without a stack trace. */
class CliError extends Error {
  override readonly name = 'CliError'
}

type PixelDiscovery = SourceConnector & {
  listPixels(ctx: ConnectionContext): Promise<PixelSummary[]>
}

/** Runs one command and returns the process exit code: 0 on success, 1 on any failure. */
export async function executeSyncCommand(
  command: SyncCommand,
  ctx: CommandContext,
): Promise<number> {
  try {
    switch (command.kind) {
      case 'help':
        ctx.io.out(USAGE.trimEnd())
        return 0
      case 'link':
        return await syncLink(command, ctx)
      case 'all':
        return await syncAll(ctx)
      case 'list-pixels':
        return await listPixels(command, ctx)
      case 'check-connection':
        return await checkConnection(command, ctx)
    }
  } catch (error) {
    if (error instanceof CliError) {
      ctx.io.err(error.message)
    } else {
      const { code } = classifySyncError(error)
      const message = error instanceof Error ? error.message : String(error)
      ctx.io.err(`Failed [${code}]: ${redact(message)}`)
    }
    return 1
  }
}

function syncDeps(ctx: CommandContext): SyncDeps {
  const { db, registry, http, logger, limiter } = ctx.runtime
  return {
    db,
    registry,
    http,
    log: logger,
    limiter,
    signal: ctx.signal,
    ...(ctx.env ? { env: ctx.env } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  }
}

async function syncLink(
  command: Extract<SyncCommand, { kind: 'link' }>,
  ctx: CommandContext,
): Promise<number> {
  const summary = await runSync(syncDeps(ctx), {
    linkId: command.linkId,
    ...(command.window ? { window: command.window } : {}),
    trigger: command.trigger,
    dryRun: command.dryRun,
    triggeredBy: null,
  })
  ctx.io.out(formatSyncSummary(summary))
  return 0
}

async function syncAll(ctx: CommandContext): Promise<number> {
  const tick = await runNightlyTick(syncDeps(ctx))
  if (!tick.acquired) {
    throw new CliError('Another process holds the nightly leader lock; nothing was run.')
  }
  if (!tick.pass) throw new CliError('The nightly pass returned no summary.')
  ctx.io.out(formatNightlyPass(tick.pass))
  return tick.pass.results.every((r) => r.outcome.status === 'succeeded') ? 0 : 1
}

async function listPixels(
  command: Extract<SyncCommand, { kind: 'list-pixels' }>,
  ctx: CommandContext,
): Promise<number> {
  const connector = ctx.runtime.registry.get(command.sourceId)
  if (!supportsPixelDiscovery(connector)) {
    throw new CliError(`${command.sourceId} has no pixel discovery; only Zeus lists pixels.`)
  }
  const credential = await pickCredential(ctx, command.sourceId, command.credential)
  const pixels = await connector.listPixels(connectionContext(ctx, credential))
  ctx.io.out(formatPixels(pixels))
  return 0
}

async function checkConnection(
  command: Extract<SyncCommand, { kind: 'check-connection' }>,
  ctx: CommandContext,
): Promise<number> {
  const matches = await repo.findCredentials(ctx.runtime.db, { idOrName: command.credential })
  const [credential, ...others] = matches
  if (!credential) {
    throw new CliError(`No credential has the name or id ${command.credential}.`)
  }
  if (others.length > 0) {
    const names = matches.map((c) => `${c.sourceId}/${c.name}`).join(', ')
    throw new CliError(
      `${command.credential} names credentials on several sources (${names}); pass the credential id.`,
    )
  }
  const connector = ctx.runtime.registry.get(credential.sourceId)
  const check = await connector.checkConnection(connectionContext(ctx, credential))
  await repo.recordCredentialCheck(ctx.runtime.db, credential.id, check.ok)
  const disabled = credential.enabled ? '' : ' (credential is disabled)'
  const verdict = check.ok ? 'OK' : 'FAILED'
  ctx.io.out(`${verdict}  ${credential.sourceId}/${credential.name}${disabled}: ${check.message}`)
  return check.ok ? 0 : 1
}

async function pickCredential(
  ctx: CommandContext,
  sourceId: string,
  idOrName: string | undefined,
): Promise<repo.CredentialRecord> {
  const matches = await repo.findCredentials(ctx.runtime.db, {
    sourceId,
    ...(idOrName ? { idOrName } : {}),
  })
  const usable = idOrName ? matches : matches.filter((c) => c.enabled)
  const [credential, ...others] = usable
  if (!credential) {
    throw new CliError(
      idOrName
        ? `No ${sourceId} credential has the name or id ${idOrName}.`
        : `No enabled ${sourceId} credential.`,
    )
  }
  if (others.length > 0) {
    const names = usable.map((c) => c.name).join(', ')
    throw new CliError(`Several ${sourceId} credentials match (${names}); pass --credential.`)
  }
  return credential
}

function connectionContext(
  ctx: CommandContext,
  credential: repo.CredentialRecord,
): ConnectionContext {
  let secret: string
  try {
    secret = resolveSecret(credential.secretEnvVar, ctx.env)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CliError(
      `Cannot use credential ${credential.sourceId}/${credential.name}: ${reason}.`,
    )
  }
  return {
    credential: {
      id: credential.id,
      name: credential.name,
      secret,
      accountScope: credential.accountScope,
    },
    http: ctx.runtime.http,
    log: ctx.runtime.logger,
    dayTimezone: credential.dayTimezone,
    signal: ctx.signal,
  }
}

function supportsPixelDiscovery(connector: SourceConnector): connector is PixelDiscovery {
  return typeof (connector as Partial<PixelDiscovery>).listPixels === 'function'
}

// ---- formatting --------------------------------------------------------------------------

const valueOrDash = (value: number | null): string => (value === null ? '-' : String(value))
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

export function formatSyncSummary(summary: SyncSummary): string {
  const lines: string[] = []
  if (summary.dryRun) {
    lines.push(
      `Dry run ${summary.syncRunId}: nothing was written (${summary.httpCalls} HTTP calls, ${seconds(summary.durationMs)}).`,
    )
    for (const day of summary.diff ?? []) lines.push(formatDayDiff(day))
  } else {
    lines.push(`Sync ${summary.syncRunId} succeeded in ${seconds(summary.durationMs)}.`)
    lines.push(`  days written   ${summary.daysWritten}`)
    lines.push(`  rows written   ${summary.rowsWritten} (replaced ${summary.rowsDeleted})`)
    lines.push(`  HTTP calls     ${summary.httpCalls}`)
  }
  for (const warning of summary.warnings) lines.push(`  warning: ${warning}`)
  return lines.join('\n')
}

/** One line per day, listing only what would change. A dash means "not measured". */
export function formatDayDiff(day: DayDiff): string {
  const changes: string[] = []
  const change = (label: string, before: number | null, after: number | null) => {
    if (before !== after) changes.push(`${label} ${valueOrDash(before)} -> ${valueOrDash(after)}`)
  }
  change('rows', day.rows.before, day.rows.after)
  for (const id of METRIC_IDS) {
    const diff = day.metrics[id]
    if (diff) change(id, diff.before, diff.after)
  }
  for (const id of METRIC_IDS) {
    for (const tag of day.perTag[id] ?? []) {
      change(`${id}[${tag.campaignTag || 'untagged'}]`, tag.before, tag.after)
    }
  }
  change('page views', day.pageViews.before, day.pageViews.after)
  change('cta clicks', day.ctaClicks.before, day.ctaClicks.after)
  return `  ${day.date}  ${changes.length > 0 ? changes.join(', ') : 'no change'}`
}

export function formatNightlyPass(pass: NightlyPassSummary): string {
  const count = (status: LinkOutcome['status']) =>
    pass.results.filter((r) => r.outcome.status === status).length
  const lines = [
    `Nightly pass${pass.deep ? ' (deep pull)' : ''}: ${count('succeeded')} synced, ${count('failed')} failed, ${count('not_run')} not run, ${pass.skipped.length} skipped, in ${seconds(pass.durationMs)}.`,
  ]
  for (const result of pass.results) {
    const where = `${result.sourceId.padEnd(5)} ${result.linkId}  ${result.window.from}..${result.window.to}  ${result.campaignName}`
    const outcome = result.outcome
    switch (outcome.status) {
      case 'succeeded':
        lines.push(
          `  ok       ${where}  ${outcome.daysWritten} days, ${outcome.rowsWritten} rows, run ${outcome.syncRunId}`,
        )
        break
      case 'failed':
        lines.push(`  FAILED   ${where}  [${outcome.code}] ${outcome.message}`)
        break
      case 'not_run':
        lines.push(`  not run  ${where}  ${outcome.reason}`)
        break
    }
  }
  for (const { candidate, reason } of pass.skipped) {
    lines.push(
      `  skipped  ${candidate.sourceId.padEnd(5)} ${candidate.linkId}  ${reason}  ${candidate.campaignName}`,
    )
  }
  return lines.join('\n')
}

export function formatPixels(pixels: readonly PixelSummary[]): string {
  if (pixels.length === 0) return 'No pixels fired in the last 7 days.'
  const header = ['pixel_id', 'external_id', 'code', 'name', 'fires (7 days)']
  const rows = pixels.map((p) => [
    p.pixel_id,
    p.external_id ?? '',
    p.code ?? '',
    p.name ?? '',
    String(p.fires_last_7_days),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}
