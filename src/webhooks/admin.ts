import { randomBytes } from 'node:crypto'
import type { Db } from '../db.ts'
import { redactUrl } from '../http/redact.ts'
import type { Logger } from '../log.ts'
import { loadSql } from '../sql-file.ts'
import { InvalidScheduleError, InvalidWebhookError, WebhookNotFoundError } from './errors.ts'
import {
  fieldWarnings,
  loadScope,
  validateFields,
  type CompiledFields,
  type PayloadFields,
} from './fields.ts'
import type { ReportWindow } from './periods.ts'
import { nextRunAfter } from './scheduler.ts'
import { assertPublicTarget, type Lookup } from './ssrf.ts'

// Creating, listing and changing client webhooks (RFC-002 §15.3). Everything that can make a
// webhook undeliverable is refused here, when a person is looking, instead of at its first tick: a
// cron that does not parse, a target that is not public HTTPS, a campaign of another company, a
// formula that cannot be read or can never have a value (src/webhooks/fields.ts).
//
// The signing secret is minted here and returned exactly once. It is the one secret this service
// keeps in the database (RFC-002 §15.5): it is per client, we generate it, and it signs nothing
// but our own payloads. It is never logged and never listed.

const sql = loadSql(import.meta.url, [
  'insert_webhook',
  'list_webhooks',
  'company_campaigns',
  'update_payload_fields',
] as const)

export interface WebhookAdminDeps {
  db: Db
  log: Logger
  now?: () => Date
  /** Injectable for tests; production resolves through DNS. */
  lookup?: Lookup
}

export interface NewWebhook {
  companyId: string
  name: string
  url: string
  /** Omitted or null = every campaign of the company, including ones created later. */
  campaignIds?: string[] | null | undefined
  scheduleCron: string
  timezone?: string | undefined
  reportWindow?: ReportWindow | undefined
  includeCheckSources?: boolean | undefined
  includeCreatives?: boolean | undefined
  enabled?: boolean | undefined
  /** What the body carries (fields.ts). Omitted or null = the full v1 body. */
  fields?: PayloadFields | null | undefined
}

export interface WebhookSummary {
  id: string
  companyId: string
  companyName: string
  name: string
  url: string
  campaignIds: string[] | null
  scheduleCron: string
  timezone: string
  reportWindow: ReportWindow
  includeCheckSources: boolean
  includeCreatives: boolean
  enabled: boolean
  nextRunAt: Date
  createdAt: Date
  /** The stored field list; null = the full v1 body. */
  fields: Record<string, unknown> | null
  lastDelivery: {
    id: string
    status: 'pending' | 'delivered' | 'failed'
    periodStart: string
    periodEnd: string
    attempts: number
    responseCode: number | null
  } | null
}

export interface CreatedWebhook {
  webhook: WebhookSummary
  /** Shown once. It cannot be read back: losing it means rotating it. */
  secret: string
  warnings: string[]
}

const DEFAULT_TIMEZONE = 'Europe/Zurich'

/** RFC-002 §15.6: the nightly sync restates yesterday at 04:00; a report before ~05:00 can miss it. */
const EARLIEST_SAFE_HOUR = 5

export function mintSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`
}

export async function createWebhook(
  deps: WebhookAdminDeps,
  input: NewWebhook,
): Promise<CreatedWebhook> {
  const now = (deps.now ?? (() => new Date()))()
  const timezone = input.timezone ?? DEFAULT_TIMEZONE

  let nextRunAt: Date
  try {
    nextRunAt = nextRunAfter(input.scheduleCron, timezone, now)
  } catch (cause) {
    throw new InvalidScheduleError(
      `scheduleCron '${input.scheduleCron}' is not a cron expression that ever fires in ${timezone}`,
      { cause },
    )
  }
  await assertPublicTarget(input.url, deps.lookup)

  const wanted = input.campaignIds ?? null
  const [company] = await deps.db.query<{ company_id: string; owned: string[] }>(
    sql.company_campaigns,
    [input.companyId, wanted ?? []],
  )
  if (!company) throw new InvalidWebhookError(`company ${input.companyId} does not exist`)
  const foreign = (wanted ?? []).filter((id) => !company.owned.includes(id))
  if (foreign.length > 0) {
    throw new InvalidWebhookError(
      `not campaigns of company ${input.companyId}: ${foreign.join(', ')}`,
    )
  }
  const fields = input.fields ?? null
  const compiled = fields === null ? null : await validateFields(deps.db, fields)

  const secret = mintSecret()
  const [row] = await deps.db.query<{ id: string }>(sql.insert_webhook, [
    input.companyId,
    input.name,
    wanted,
    input.url,
    secret,
    input.scheduleCron,
    timezone,
    input.reportWindow ?? 'previous_week',
    input.includeCheckSources ?? true,
    input.includeCreatives ?? true,
    input.enabled ?? true,
    nextRunAt,
    fields === null ? null : JSON.stringify(fields),
  ])
  if (!row) throw new Error('insert_webhook returned no row')

  const [webhook] = await listWebhooks(deps.db, row.id)
  if (!webhook) throw new Error(`webhook ${row.id} vanished after insert`)

  deps.log.info(
    { webhookId: webhook.id, companyId: webhook.companyId, url: redactUrl(webhook.url), nextRunAt },
    'webhook created',
  )
  return {
    webhook,
    secret,
    warnings: [
      ...scheduleWarnings(nextRunAt, timezone),
      ...(await warningsFor(deps.db, compiled, input.companyId, wanted)),
    ],
  }
}

export interface UpdatedWebhook {
  webhook: WebhookSummary
  warnings: string[]
}

/**
 * Replaces what a webhook delivers; null goes back to the full v1 body. Validated like at
 * creation. Applies from the next body built: a delivery already queued keeps the body it has.
 */
export async function updateWebhookFields(
  deps: WebhookAdminDeps,
  id: string,
  fields: PayloadFields | null,
): Promise<UpdatedWebhook> {
  const compiled = fields === null ? null : await validateFields(deps.db, fields)
  const [target] = await deps.db.query<{ company_id: string; campaign_ids: string[] | null }>(
    sql.update_payload_fields,
    [id, fields === null ? null : JSON.stringify(fields)],
  )
  if (!target) throw new WebhookNotFoundError(`webhook ${id} does not exist`)

  const [webhook] = await listWebhooks(deps.db, id)
  if (!webhook) throw new WebhookNotFoundError(`webhook ${id} does not exist`)

  deps.log.info(
    { webhookId: id, calculated: fields?.calculated.map((field) => field.name) ?? [] },
    'webhook field list changed',
  )
  return {
    webhook,
    warnings: await warningsFor(deps.db, compiled, target.company_id, target.campaign_ids),
  }
}

async function warningsFor(
  db: Db,
  fields: CompiledFields | null,
  companyId: string,
  campaignIds: readonly string[] | null,
): Promise<string[]> {
  if (fields === null || fields.calculated.length === 0) return []
  return fieldWarnings(fields, await loadScope(db, companyId, campaignIds))
}

export async function listWebhooks(db: Db, id?: string): Promise<WebhookSummary[]> {
  const rows = await db.query<{
    id: string
    company_id: string
    company_name: string
    name: string
    url: string
    campaign_ids: string[] | null
    schedule_cron: string
    timezone: string
    report_window: ReportWindow
    include_check_sources: boolean
    include_creatives: boolean
    enabled: boolean
    next_run_at: Date
    created_at: Date
    payload_fields: Record<string, unknown> | null
    last_delivery: WebhookSummary['lastDelivery']
  }>(sql.list_webhooks, [id ?? null])
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    name: row.name,
    url: row.url,
    campaignIds: row.campaign_ids,
    scheduleCron: row.schedule_cron,
    timezone: row.timezone,
    reportWindow: row.report_window,
    includeCheckSources: row.include_check_sources,
    includeCreatives: row.include_creatives,
    enabled: row.enabled,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    fields: row.payload_fields,
    lastDelivery: row.last_delivery,
  }))
}

/** Pure: what a person should know about this schedule before they rely on it. */
export function scheduleWarnings(nextRunAt: Date, timezone: string): string[] {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(nextRunAt),
  )
  if (hour >= EARLIEST_SAFE_HOUR) return []
  return [
    `fires at ${String(hour).padStart(2, '0')}:xx ${timezone}: the nightly sync restates yesterday at 04:00 Europe/Zurich, so a report this early can miss it. 06:00 or later is safe; the payload's data_complete_through always tells the client what is settled.`,
  ]
}
