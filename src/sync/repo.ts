import type { Queryable } from '../db.ts'
import type { DateWindow, IsoDate } from '../dates.ts'
import { sqlFile } from '../sql-file.ts'
import type { EventMapEntry, LinkEntity, LinkRecord, RawCapture, SourceRecord } from './types.ts'

// All sync bookkeeping SQL, one function per statement. Statements live in ./sql/*.sql.
const sql = (name: string) => sqlFile(import.meta.url, name)

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
  const [row] = await db.query<LinkRow>(sql('load_link'), [linkId])
  if (!row) return undefined
  const [entities, eventMap] = await Promise.all([
    db.query<EntityRow>(sql('load_entities'), [linkId]),
    db.query<EventMapRow>(sql('load_event_map'), [linkId]),
  ])
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
  const rows = await db.query<{ kind: 'page' | 'cta'; id: string }>(sql('load_campaign_targets'), [
    campaignId,
  ])
  return {
    pages: new Set(rows.filter((r) => r.kind === 'page').map((r) => r.id)),
    ctas: new Set(rows.filter((r) => r.kind === 'cta').map((r) => r.id)),
  }
}

export async function secondsSinceLastRun(
  db: Queryable,
  linkId: string,
): Promise<number | undefined> {
  const [row] = await db.query<{ elapsed_seconds: number }>(sql('last_run_started_at'), [linkId])
  return row?.elapsed_seconds
}

export type SyncTrigger = 'cron' | 'manual' | 'backfill'

export async function insertRun(
  db: Queryable,
  run: {
    linkId: string
    trigger: SyncTrigger
    triggeredBy: string | null
    window: DateWindow
    dryRun: boolean
  },
): Promise<string> {
  const [row] = await db.query<{ id: string }>(sql('insert_run'), [
    run.linkId,
    run.trigger,
    run.triggeredBy,
    run.window.from,
    run.window.to,
    run.dryRun,
  ])
  if (!row) throw new Error('insert_run returned no id')
  return row.id
}

export async function finishRun(
  db: Queryable,
  runId: string,
  result: { daysWritten: number; rowsWritten: number; warnings: string[] },
): Promise<void> {
  await db.query(sql('finish_run'), [
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
  await db.query(sql('fail_run'), [runId, error, JSON.stringify(warnings)])
}

export async function insertRawPayloads(
  db: Queryable,
  runId: string,
  captures: readonly RawCapture[],
): Promise<void> {
  if (captures.length === 0) return
  await db.query(sql('insert_raw_payloads'), [
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
  await db.query(sql('upsert_sync_state'), [
    linkId,
    JSON.stringify(state.cursor),
    state.dataCompleteThrough,
    state.deep,
  ])
}
