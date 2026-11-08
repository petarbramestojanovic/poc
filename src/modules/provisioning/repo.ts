import type { Queryable } from '../../core/db.ts'
import { loadSql } from '../../core/sql-file.ts'
import type { NewResource, ProvisionedResourceRecord } from '../sync/types.ts'

const sql = loadSql(import.meta.url, [
  'open_run',
  'finish_run',
  'insert_resources',
  'list_resources',
] as const)

export type ProvisioningTrigger = 'manual' | 'crm' | 'creative'

/** The run id, or undefined while another run of this campaign is in progress. */
export async function openRun(
  q: Queryable,
  campaignId: string,
  trigger: ProvisioningTrigger,
): Promise<string | undefined> {
  const rows = await q.query<{ id: string }>(sql.open_run, [campaignId, trigger])
  return rows[0]?.id
}

export async function finishRun(
  q: Queryable,
  runId: string,
  outcome: { error: string | null; warnings: readonly string[]; steps: readonly unknown[] },
): Promise<void> {
  await q.query(sql.finish_run, [
    runId,
    outcome.error,
    JSON.stringify(outcome.warnings),
    JSON.stringify(outcome.steps),
  ])
}

/** Stores what a step created; returns how many were new. */
export async function insertResources(
  q: Queryable,
  target: { campaignId: string; creativeId: string | null; sourceId: string },
  resources: readonly NewResource[],
): Promise<number> {
  if (resources.length === 0) return 0
  const rows = await q.query(sql.insert_resources, [
    target.sourceId,
    target.campaignId,
    target.creativeId,
    resources.map((r) => r.kind),
    resources.map((r) => r.externalId),
  ])
  return rows.length
}

export async function listResources(
  q: Queryable,
  campaignId: string,
): Promise<ProvisionedResourceRecord[]> {
  const rows = await q.query<{
    source_id: string
    kind: string
    external_id: string
    creative_id: string | null
  }>(sql.list_resources, [campaignId])
  return rows.map((row) => ({
    source: row.source_id,
    kind: row.kind,
    externalId: row.external_id,
    creativeId: row.creative_id,
  }))
}
