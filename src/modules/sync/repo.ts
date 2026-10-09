import type { Db, Queryable } from '../../core/db.ts'
import type { DateWindow, IsoDate } from '../../core/dates.ts'
import { loadSql } from '../../core/sql-file.ts'
import { RunInProgressError, TooSoonError } from './errors.ts'
import type { EventMapEntry, LinkEntity, LinkRecord, RawCapture, SourceRecord } from './types.ts'
import type { LookbackSource } from './windows.ts'

// All sync bookkeeping SQL, one function per statement. Statements live in ./sql/*.sql and are
// loaded at import time.
const sql = loadSql(import.meta.url, [
  'load_link',
  'load_entities',
  'load_event_map',
  'load_campaign_targets',
  'load_enabled_platform_sources',
  'run_gate_status',
  'insert_run',
  'finish_run',
  'fail_run',
  'insert_raw_payloads',
  'upsert_sync_state',
  'upsert_unmapped',
  'load_nightly_links',
  'load_credentials',
  'record_credential_check',
  'load_run',
] as const)

export interface CredentialPointer {
  id: string
  name: string
  secretEnvVar: string
  accountScope: Record<string, unknown>
  enabled: boolean
}

export interface LinkContext {
  link: LinkRecord
  source: SourceRecord & { minManualIntervalSeconds: number }
  credential: CredentialPointer
  campaign: { id: string; companyId: string; name: string }
  entities: LinkEntity[]
  eventMap: EventMapEntry[]
}

interface LinkRow {
  id: string
  campaign_id: string
  source_id: string
  credential_id: string
  language: string
  config: unknown
  enabled: boolean
  source_display_name: string
  day_timezone: string
  lookback_days: number
  deep_lookback_days: number
  max_window_days: number
  min_manual_interval_seconds: number
  credential_name: string
  secret_env_var: string
  account_scope: Record<string, unknown>
  credential_enabled: boolean
  company_id: string
  campaign_name: string
}

interface EntityRow {
  level: LinkEntity['level']
  external_id: string
  role: string | null
  label: string | null
  campaign_tag: string
}

interface EventMapRow {
  event_name: string
  target_kind: EventMapEntry['targetKind']
  target_id: string | null
}

export async function loadLinkContext(
  db: Queryable,
  linkId: string,
): Promise<LinkContext | undefined> {
  const [row] = await db.query<LinkRow>(sql.load_link, [linkId])
  if (!row) return undefined
  const entities = await db.query<EntityRow>(sql.load_entities, [linkId])
  const eventMap = await db.query<EventMapRow>(sql.load_event_map, [linkId])
  return {
    link: {
      id: row.id,
      campaignId: row.campaign_id,
      sourceId: row.source_id,
      credentialId: row.credential_id,
      language: row.language,
      config: row.config,
      enabled: row.enabled,
    },
    source: {
      id: row.source_id,
      displayName: row.source_display_name,
      dayTimezone: row.day_timezone,
      lookbackDays: row.lookback_days,
      deepLookbackDays: row.deep_lookback_days,
      maxWindowDays: row.max_window_days,
      minManualIntervalSeconds: row.min_manual_interval_seconds,
    },
    credential: {
      id: row.credential_id,
      name: row.credential_name,
      secretEnvVar: row.secret_env_var,
      accountScope: row.account_scope,
      enabled: row.credential_enabled,
    },
    campaign: { id: row.campaign_id, companyId: row.company_id, name: row.campaign_name },
    entities: entities.map((e) => ({
      level: e.level,
      externalId: e.external_id,
      role: e.role,
      label: e.label,
      campaignTag: e.campaign_tag,
    })),
    eventMap: eventMap.map((m) => ({
      eventName: m.event_name,
      targetKind: m.target_kind,
      targetId: m.target_id,
    })),
  }
}

export async function loadCampaignTargets(
  db: Queryable,
  campaignId: string,
): Promise<{ pages: Set<string>; ctas: Set<string> }> {
  const rows = await db.query<{ kind: 'page' | 'cta'; id: string }>(sql.load_campaign_targets, [
    campaignId,
  ])
  return {
    pages: new Set(rows.filter((r) => r.kind === 'page').map((r) => r.id)),
    ctas: new Set(rows.filter((r) => r.kind === 'cta').map((r) => r.id)),
  }
}

export async function loadEnabledPlatformSourceIds(db: Queryable): Promise<string[]> {
  const rows = await db.query<{ id: string }>(sql.load_enabled_platform_sources)
  return rows.map((r) => r.id)
}

export type SyncTrigger = 'cron' | 'manual' | 'backfill'

export interface NewRun {
  linkId: string
  trigger: SyncTrigger
  triggeredBy: string | null
  window: DateWindow
  dryRun: boolean
}

/**
 * Opens a run. For real (non-dry) runs the check and the insert happen in one transaction under
 * a per-link gate lock, so two triggers arriving together cannot both proceed: a link has at most
 * one real run in flight, and a manual run respects the source's cooldown.
 */
export async function openRun(
  db: Db,
  run: NewRun,
  manualCooldownSeconds: number | null,
): Promise<string> {
  return db.withTransaction(async (tx) => {
    if (!run.dryRun) {
      await tx.xactLock(`sync-run-gate:${run.linkId}`)
      const [gate] = await tx.query<{ running: boolean; elapsed_seconds: number | null }>(
        sql.run_gate_status,
        [run.linkId],
      )
      if (gate?.running) {
        throw new RunInProgressError(`link ${run.linkId} already has a sync run in progress`)
      }
      if (manualCooldownSeconds !== null && gate?.elapsed_seconds != null) {
        const remaining = Math.ceil(manualCooldownSeconds - gate.elapsed_seconds)
        if (remaining > 0) {
          throw new TooSoonError(
            `last run for link ${run.linkId} was ${Math.round(gate.elapsed_seconds)} s ago; wait ${remaining} s`,
            remaining,
          )
        }
      }
    }
    const [row] = await tx.query<{ id: string }>(sql.insert_run, [
      run.linkId,
      run.trigger,
      run.triggeredBy,
      run.window.from,
      run.window.to,
      run.dryRun,
    ])
    if (!row) throw new Error('insert_run returned no id')
    return row.id
  })
}

export async function finishRun(
  db: Queryable,
  runId: string,
  result: { daysWritten: number; rowsWritten: number; warnings: string[] },
): Promise<void> {
  await db.query(sql.finish_run, [
    runId,
    result.daysWritten,
    result.rowsWritten,
    JSON.stringify(result.warnings),
  ])
}

export async function failRun(
  db: Queryable,
  runId: string,
  error: string,
  warnings: string[],
): Promise<void> {
  await db.query(sql.fail_run, [runId, error, JSON.stringify(warnings)])
}

export async function insertRawPayloads(
  db: Queryable,
  runId: string,
  captures: readonly RawCapture[],
): Promise<void> {
  if (captures.length === 0) return
  await db.query(sql.insert_raw_payloads, [
    runId,
    captures.map((c) => JSON.stringify(c.request)),
    captures.map((c) => JSON.stringify(c.response)),
    captures.map((c) => c.fetchedAt),
  ])
}

export async function upsertSyncState(
  db: Queryable,
  linkId: string,
  state: { cursor: unknown; dataCompleteThrough: IsoDate | null; deep: boolean },
): Promise<void> {
  await db.query(sql.upsert_sync_state, [
    linkId,
    JSON.stringify(state.cursor),
    state.dataCompleteThrough,
    state.deep,
  ])
}

export interface UnmappedTotal {
  eventName: string
  firstSeen: IsoDate
  lastSeen: IsoDate
  totalCount: number
}

export async function upsertUnmapped(
  db: Queryable,
  linkId: string,
  totals: readonly UnmappedTotal[],
): Promise<void> {
  if (totals.length === 0) return
  await db.query(sql.upsert_unmapped, [
    linkId,
    totals.map((t) => t.eventName),
    totals.map((t) => t.firstSeen),
    totals.map((t) => t.lastSeen),
    totals.map((t) => t.totalCount),
  ])
}

export interface NightlyCandidate {
  linkId: string
  sourceId: string
  credentialId: string
  campaignId: string
  campaignName: string
  campaignStatus: 'draft' | 'active' | 'archived'
  startsOn: IsoDate | null
  endsOn: IsoDate | null
  source: LookbackSource
}

interface NightlyLinkRow {
  link_id: string
  source_id: string
  credential_id: string
  campaign_id: string
  campaign_name: string
  campaign_status: NightlyCandidate['campaignStatus']
  starts_on: IsoDate | null
  ends_on: IsoDate | null
  day_timezone: string
  lookback_days: number
  deep_lookback_days: number
}

/** Enabled links on enabled credentials and platform sources, with what the nightly skip rules need. */
export async function loadNightlyCandidates(db: Queryable): Promise<NightlyCandidate[]> {
  const rows = await db.query<NightlyLinkRow>(sql.load_nightly_links)
  return rows.map((row) => ({
    linkId: row.link_id,
    sourceId: row.source_id,
    credentialId: row.credential_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    campaignStatus: row.campaign_status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    source: {
      id: row.source_id,
      dayTimezone: row.day_timezone,
      lookbackDays: row.lookback_days,
      deepLookbackDays: row.deep_lookback_days,
    },
  }))
}

export interface CredentialRecord {
  id: string
  name: string
  sourceId: string
  secretEnvVar: string
  accountScope: Record<string, unknown>
  enabled: boolean
  dayTimezone: string
}

interface CredentialRow {
  id: string
  name: string
  source_id: string
  secret_env_var: string
  account_scope: Record<string, unknown>
  enabled: boolean
  day_timezone: string
}

export async function findCredentials(
  db: Queryable,
  match: { idOrName?: string; sourceId?: string },
): Promise<CredentialRecord[]> {
  const rows = await db.query<CredentialRow>(sql.load_credentials, [
    match.idOrName ?? null,
    match.sourceId ?? null,
  ])
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sourceId: row.source_id,
    secretEnvVar: row.secret_env_var,
    accountScope: row.account_scope,
    enabled: row.enabled,
    dayTimezone: row.day_timezone,
  }))
}

export async function recordCredentialCheck(
  db: Queryable,
  credentialId: string,
  ok: boolean,
): Promise<void> {
  await db.query(sql.record_credential_check, [credentialId, ok])
}

export interface SyncRunRecord {
  id: string
  linkId: string
  trigger: SyncTrigger
  dryRun: boolean
  status: 'running' | 'succeeded' | 'failed'
  window: DateWindow
  startedAt: string
  finishedAt: string | null
  daysWritten: number | null
  rowsWritten: number | null
  warnings: string[]
  /** Redacted when it was recorded. */
  error: string | null
}

interface SyncRunRow {
  id: string
  link_id: string
  trigger: SyncTrigger
  dry_run: boolean
  status: SyncRunRecord['status']
  window_from: IsoDate
  window_to: IsoDate
  started_at: Date
  finished_at: Date | null
  days_written: number | null
  rows_written: number | null
  warnings: string[]
  error: string | null
}

export async function loadRun(db: Queryable, runId: string): Promise<SyncRunRecord | undefined> {
  const [row] = await db.query<SyncRunRow>(sql.load_run, [runId])
  if (!row) return undefined
  return {
    id: row.id,
    linkId: row.link_id,
    trigger: row.trigger,
    dryRun: row.dry_run,
    status: row.status,
    window: { from: row.window_from, to: row.window_to },
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    daysWritten: row.days_written,
    rowsWritten: row.rows_written,
    warnings: row.warnings,
    error: row.error,
  }
}
