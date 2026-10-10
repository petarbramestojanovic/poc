import { randomBytes } from 'node:crypto'
import type { Db, Queryable } from '../../core/db.ts'
import { redactUrl } from '../../core/http/redact.ts'
import type { Logger } from '../../core/log.ts'
import { loadSql } from '../../core/sql-file.ts'
import { InvalidScheduleError, InvalidWebhookError, WebhookNotFoundError } from './errors.ts'
import {
  fieldWarnings,
  loadScope,
  readStoredFields,
  validateFields,
  type CompiledFields,
  type PayloadFields,
} from './fields.ts'
import { PAYLOAD_VERSION, type Format } from './payload.ts'
import {
  DEFAULT_CRON,
  frequencyOf,
  windowOf,
  type Frequency,
  type ReportWindow,
} from './periods.ts'
import { nextRunAfter } from './scheduler.ts'
import { assertPublicTarget, type Lookup } from './ssrf.ts'

// Creating, listing and changing client webhooks (RFC-002 §15.3). Everything that can make a
// webhook undeliverable is refused here, when a person is looking, instead of at its first tick: a
// cron that does not parse, a target that is not public HTTPS, a campaign of another company, a
// formula that cannot be read or can never have a value (fields.ts), a csv webhook without the key
// its importer needs or without a public address to link to.
//
// Two secrets live on a webhook, and neither ever comes back out of this module after it is set:
//   * the signing secret, minted here and returned exactly once (RFC-002 §15.5);
//   * the client's own key (auth_token, migration 0008), entered by a Brame admin and sent in
//     `auth_header` with every delivery. Listing shows the header's name, never the key.

const sql = loadSql(import.meta.url, [
  'insert_webhook',
  'list_webhooks',
  'company_campaigns',
  'lock_webhook',
  'update_webhook',
] as const)

/** The header Funnel's File Import webhook authenticates with; a csv webhook always uses it. */
export const FUNNEL_TOKEN_HEADER = 'x-funnel-fileimport-token'

/** A json webhook's key goes here unless the admin names another header. */
export const DEFAULT_AUTH_HEADER = 'authorization'

/** Headers every delivery sets itself (deliver.ts, HttpClient): a client's key can replace none. */
const OWN_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'transfer-encoding',
  'user-agent',
  'x-delivery-id',
  'x-payload-version',
  'x-signature',
  'x-timestamp',
])

const DEFAULT_TIMEZONE = 'Europe/Zurich'

export interface WebhookAdminDeps {
  db: Db
  log: Logger
  /** config.publicBaseUrl: a csv webhook cannot be set up without it. */
  exportBaseUrl?: string | undefined
  now?: () => Date
  /** Injectable for tests; production resolves through DNS. */
  lookup?: Lookup
}

/** The client's key as an admin enters it. */
export interface WebhookAuthInput {
  /** Lowercase header name; default `authorization` (json) or Funnel's header (csv). */
  header?: string | undefined
  token: string
}

export interface NewWebhook {
  companyId: string
  name: string
  url: string
  /** Omitted or null = every campaign of the company, including ones created later. */
  campaignIds?: string[] | null | undefined
  frequency: Frequency
  /** Omitted = DEFAULT_CRON of the frequency (05:00). */
  scheduleCron?: string | undefined
  timezone?: string | undefined
  /** Omitted = json. */
  format?: Format | undefined
  auth?: WebhookAuthInput | undefined
  fields: PayloadFields
  enabled?: boolean | undefined
}

/** A PATCH: every key is optional, and an omitted key keeps what is stored. */
export interface WebhookChanges {
  name?: string | undefined
  url?: string | undefined
  /** null = every campaign of the company. */
  campaignIds?: string[] | null | undefined
  frequency?: Frequency | undefined
  /** null = the default cron of the (new) frequency. */
  scheduleCron?: string | null | undefined
  timezone?: string | undefined
  format?: Format | undefined
  /** null = send no key (a json webhook only). */
  auth?: WebhookAuthInput | null | undefined
  fields?: PayloadFields | undefined
  enabled?: boolean | undefined
}

export interface WebhookSummary {
  id: string
  companyId: string
  companyName: string
  name: string
  url: string
  campaignIds: string[] | null
  frequency: Frequency
  scheduleCron: string
  timezone: string
  format: Format
  /** The header the client's key goes in; the key itself is never shown. */
  auth: { header: string } | null
  enabled: boolean
  nextRunAt: Date
  createdAt: Date
  /** The stored column list. */
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

export interface UpdatedWebhook {
  webhook: WebhookSummary
  warnings: string[]
}

interface Auth {
  header: string
  token: string
}

export function mintSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`
}

export async function createWebhook(
  deps: WebhookAdminDeps,
  input: NewWebhook,
): Promise<CreatedWebhook> {
  const now = (deps.now ?? (() => new Date()))()
  const timezone = input.timezone ?? DEFAULT_TIMEZONE
  const cron = input.scheduleCron ?? DEFAULT_CRON[input.frequency]
  const format = input.format ?? 'json'

  const nextRunAt = firstRun(cron, timezone, now)
  const auth = input.auth === undefined ? null : authFor(format, input.auth)
  checkCsvAuth(format, auth)
  if (format === 'csv') checkExportBase(deps)
  await assertPublicTarget(input.url, deps.lookup)

  const campaignIds = input.campaignIds ?? null
  await checkCampaigns(deps.db, input.companyId, campaignIds)
  const compiled = await validateFields(deps.db, input.fields)

  const secret = mintSecret()
  const [row] = await deps.db.query<{ id: string }>(sql.insert_webhook, [
    input.companyId,
    input.name,
    campaignIds,
    input.url,
    secret,
    cron,
    timezone,
    windowOf(input.frequency),
    format,
    auth?.header ?? null,
    auth?.token ?? null,
    PAYLOAD_VERSION,
    input.enabled ?? true,
    nextRunAt,
    JSON.stringify(input.fields),
  ])
  if (!row) throw new Error('insert_webhook returned no row')

  const [webhook] = await listWebhooks(deps.db, row.id)
  if (!webhook) throw new Error(`webhook ${row.id} vanished after insert`)

  deps.log.info(
    {
      webhookId: webhook.id,
      companyId: webhook.companyId,
      url: redactUrl(webhook.url),
      format,
      frequency: input.frequency,
      nextRunAt,
    },
    'webhook created',
  )
  return {
    webhook,
    secret,
    warnings: await warningsFor(deps.db, compiled, input.companyId, campaignIds),
  }
}

interface LockedRow {
  id: string
  company_id: string
  name: string
  campaign_ids: string[] | null
  url: string
  schedule_cron: string
  timezone: string
  report_window: ReportWindow
  format: Format
  auth_header: string | null
  auth_token: string | null
  enabled: boolean
  next_run_at: Date
  payload_fields: unknown
}

/**
 * Changes what a PATCH names and keeps the rest; the result is checked as a whole, like a new
 * webhook. Applies from the next report built: a delivery already queued keeps its document.
 */
export async function updateWebhook(
  deps: WebhookAdminDeps,
  id: string,
  changes: WebhookChanges,
): Promise<UpdatedWebhook> {
  const now = (deps.now ?? (() => new Date()))()
  // Outside the transaction: a DNS lookup should not hold the row lock.
  if (changes.url !== undefined) await assertPublicTarget(changes.url, deps.lookup)

  const result = await deps.db.withTransaction(async (tx) => {
    const [current] = await tx.query<LockedRow>(sql.lock_webhook, [id])
    if (!current) throw new WebhookNotFoundError(`webhook ${id} does not exist`)

    const storedFrequency = frequencyOf(current.report_window)
    const frequency = changes.frequency ?? storedFrequency
    const cron =
      changes.scheduleCron === undefined
        ? // A webhook on its frequency's default follows a new frequency to that one's default.
          changes.frequency !== undefined && current.schedule_cron === DEFAULT_CRON[storedFrequency]
          ? DEFAULT_CRON[frequency]
          : current.schedule_cron
        : (changes.scheduleCron ?? DEFAULT_CRON[frequency])
    const timezone = changes.timezone ?? current.timezone
    const format = changes.format ?? current.format
    const enabled = changes.enabled ?? current.enabled
    const campaignIds =
      changes.campaignIds === undefined ? current.campaign_ids : changes.campaignIds

    const stored: Auth | null =
      current.auth_header !== null && current.auth_token !== null
        ? { header: current.auth_header, token: current.auth_token }
        : null
    const auth =
      changes.auth === undefined
        ? stored
        : changes.auth === null
          ? null
          : authFor(format, changes.auth)
    checkCsvAuth(format, auth)
    // A missing PUBLIC_BASE_URL blocks turning a webhook into csv, never editing (or disabling) one.
    if (changes.format === 'csv') checkExportBase(deps)

    const scheduleChanged =
      cron !== current.schedule_cron ||
      timezone !== current.timezone ||
      (enabled && !current.enabled)
    const nextRunAt = scheduleChanged ? firstRun(cron, timezone, now) : current.next_run_at

    if (changes.campaignIds !== undefined) {
      await checkCampaigns(tx, current.company_id, campaignIds)
    }
    let compiled: CompiledFields
    if (changes.fields !== undefined) {
      compiled = await validateFields(tx, changes.fields)
    } else {
      try {
        compiled = readStoredFields(current.payload_fields)
      } catch (cause) {
        throw new InvalidWebhookError(
          `webhook ${id} has no usable column list; pass fields with this change`,
          { cause },
        )
      }
    }

    await tx.query(sql.update_webhook, [
      id,
      changes.name ?? current.name,
      campaignIds,
      changes.url ?? current.url,
      cron,
      timezone,
      windowOf(frequency),
      format,
      auth?.header ?? null,
      auth?.token ?? null,
      changes.fields === undefined
        ? JSON.stringify(current.payload_fields)
        : JSON.stringify(changes.fields),
      enabled,
      nextRunAt,
    ])
    return { companyId: current.company_id, campaignIds, compiled }
  })

  const [webhook] = await listWebhooks(deps.db, id)
  if (!webhook) throw new WebhookNotFoundError(`webhook ${id} does not exist`)

  // Which settings changed, by name only: never a URL's query, never the key.
  deps.log.info({ webhookId: id, changed: Object.keys(changes) }, 'webhook changed')
  return {
    webhook,
    warnings: await warningsFor(deps.db, result.compiled, result.companyId, result.campaignIds),
  }
}

function firstRun(cron: string, timezone: string, now: Date): Date {
  try {
    return nextRunAfter(cron, timezone, now)
  } catch (cause) {
    throw new InvalidScheduleError(
      `scheduleCron '${cron}' is not a cron expression that ever fires in ${timezone}`,
      { cause },
    )
  }
}

/** The key as it will be stored: its header named, lowercase, and never one of our own. */
function authFor(format: Format, input: WebhookAuthInput): Auth {
  const header = (
    input.header ?? (format === 'csv' ? FUNNEL_TOKEN_HEADER : DEFAULT_AUTH_HEADER)
  ).toLowerCase()
  if (OWN_HEADERS.has(header)) {
    throw new InvalidWebhookError(`auth.header '${header}' is a header every delivery sets itself`)
  }
  return { header, token: input.token }
}

/** Funnel denies a request without its token, so a csv webhook always carries one, in its header. */
function checkCsvAuth(format: Format, auth: Auth | null): void {
  if (format !== 'csv') return
  if (auth === null) {
    throw new InvalidWebhookError(
      `a csv webhook needs the token of the client's Funnel File Import (auth.token)`,
    )
  }
  if (auth.header !== FUNNEL_TOKEN_HEADER) {
    throw new InvalidWebhookError(
      `a csv webhook authenticates with ${FUNNEL_TOKEN_HEADER}; pass auth with Funnel's token`,
    )
  }
}

/** A csv webhook links to its file on this service, which needs a public address to link to. */
function checkExportBase(deps: Pick<WebhookAdminDeps, 'exportBaseUrl'>): void {
  if (deps.exportBaseUrl === undefined) {
    throw new InvalidWebhookError(
      'a csv webhook links to its file on this service, and PUBLIC_BASE_URL is not set',
    )
  }
}

/** The company exists, and every listed campaign is its own: a report never crosses companies. */
async function checkCampaigns(
  q: Queryable,
  companyId: string,
  campaignIds: readonly string[] | null,
): Promise<void> {
  const [company] = await q.query<{ company_id: string; owned: string[] }>(sql.company_campaigns, [
    companyId,
    campaignIds ?? [],
  ])
  if (!company) throw new InvalidWebhookError(`company ${companyId} does not exist`)
  const foreign = (campaignIds ?? []).filter((id) => !company.owned.includes(id))
  if (foreign.length > 0) {
    throw new InvalidWebhookError(`not campaigns of company ${companyId}: ${foreign.join(', ')}`)
  }
}

async function warningsFor(
  db: Db,
  fields: CompiledFields,
  companyId: string,
  campaignIds: readonly string[] | null,
): Promise<string[]> {
  return fieldWarnings(fields, await loadScope(db, companyId, campaignIds, fields.source))
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
    format: Format
    auth_header: string | null
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
    frequency: frequencyOf(row.report_window),
    scheduleCron: row.schedule_cron,
    timezone: row.timezone,
    format: row.format,
    auth: row.auth_header === null ? null : { header: row.auth_header },
    enabled: row.enabled,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    fields: row.payload_fields,
    lastDelivery: row.last_delivery,
  }))
}
