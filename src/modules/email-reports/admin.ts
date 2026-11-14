import type { Db, Queryable } from '../../core/db.ts'
import type { Logger } from '../../core/log.ts'
import { isEmailAddress } from '../../core/mail/address.ts'
import { MailNotConfiguredError } from '../../core/mail/errors.ts'
import type { Mailer } from '../../core/mail/types.ts'
import { loadSql } from '../../core/sql-file.ts'
import {
  DEFAULT_CRON,
  frequencyOf,
  windowOf,
  type Frequency,
  type ReportWindow,
} from '../webhooks/periods.ts'
import { nextRunAfter } from '../webhooks/scheduler.ts'
import { EmailReportNotFoundError, InvalidEmailReportError } from './errors.ts'
import { kindOf, type KindName } from './kinds/index.ts'

// Creating, listing and changing email reports. Everything that would make a report unsendable is
// refused here, while a person is looking, instead of at its first tick: an unknown company, a
// campaign of another one, a cron that never fires, a recipient that is not an address or is listed
// twice, settings its kind cannot use. A report is created only while email is on; it can be
// changed, listed and previewed with email off, so it can be switched off or fixed.
//
// Recipients are listed (an admin route), but never logged: log lines carry their count.

const sql = loadSql(import.meta.url, [
  'company_campaigns',
  'insert_report',
  'lock_report',
  'update_report',
  'list_reports',
] as const)

/** app.email_report allows 1–20; one email goes to all of them. */
export const MAX_REPORT_RECIPIENTS = 20

const DEFAULT_TIMEZONE = 'Europe/Zurich'
const DEFAULT_KIND: KindName = 'rows'

export interface EmailReportAdminDeps {
  db: Db
  /** Unset when email is off: no report can be created. */
  mailer?: Mailer | undefined
  log: Logger
  now?: () => Date
}

export interface NewEmailReport {
  companyId: string
  name: string
  /** Omitted = rows. */
  kind?: KindName | undefined
  recipients: string[]
  /** Omitted or null = every campaign of the company, including ones created later. */
  campaignIds?: string[] | null | undefined
  frequency: Frequency
  /** Omitted = the frequency's default (05:00 every day, Monday or 1st). */
  scheduleCron?: string | undefined
  timezone?: string | undefined
  /** Per kind; rows: { format, fields }. */
  settings: unknown
  enabled?: boolean | undefined
}

/** A PATCH: every key is optional, and an omitted key keeps what is stored. */
export interface EmailReportChanges {
  name?: string | undefined
  /** The whole list. */
  recipients?: string[] | undefined
  /** null = every campaign of the company. */
  campaignIds?: string[] | null | undefined
  frequency?: Frequency | undefined
  /** null = the default cron of the (new) frequency. */
  scheduleCron?: string | null | undefined
  timezone?: string | undefined
  settings?: unknown
  enabled?: boolean | undefined
}

export interface EmailReportSummary {
  id: string
  companyId: string
  companyName: string
  name: string
  kind: string
  campaignIds: string[] | null
  recipients: string[]
  frequency: Frequency
  scheduleCron: string
  timezone: string
  settings: Record<string, unknown>
  enabled: boolean
  nextRunAt: Date
  createdAt: Date
  lastDelivery: {
    id: string
    trigger: 'schedule' | 'manual'
    status: 'pending' | 'delivered' | 'failed'
    periodStart: string
    periodEnd: string
    attempts: number
    lastAttemptAt: string | null
    error: string | null
  } | null
}

export interface SavedEmailReport {
  report: EmailReportSummary
  /** What an admin should know, e.g. a campaign without a link to the report's source. */
  warnings: string[]
}

export async function createEmailReport(
  deps: EmailReportAdminDeps,
  input: NewEmailReport,
): Promise<SavedEmailReport> {
  if (deps.mailer === undefined) throw new MailNotConfiguredError()
  const now = (deps.now ?? (() => new Date()))()
  const kindName = input.kind ?? DEFAULT_KIND
  const kind = kindOf(kindName)
  const timezone = input.timezone ?? DEFAULT_TIMEZONE
  const cron = input.scheduleCron ?? DEFAULT_CRON[input.frequency]
  const nextRunAt = firstRun(cron, timezone, now)
  const recipients = checkRecipients(input.recipients)
  const campaignIds = input.campaignIds ?? null

  await checkCampaigns(deps.db, input.companyId, campaignIds)
  const { settings, warnings } = await kind.validate(deps.db, input.settings, {
    companyId: input.companyId,
    campaignIds,
  })

  const [row] = await deps.db.query<{ id: string }>(sql.insert_report, [
    input.companyId,
    input.name,
    kindName,
    campaignIds,
    recipients,
    cron,
    timezone,
    windowOf(input.frequency),
    JSON.stringify(settings),
    input.enabled ?? true,
    nextRunAt,
  ])
  if (!row) throw new Error('insert_report returned no row')

  const [report] = await listEmailReports(deps.db, row.id)
  if (!report) throw new Error(`email report ${row.id} vanished after insert`)

  deps.log.info(
    {
      emailReportId: report.id,
      companyId: report.companyId,
      kind: kindName,
      recipients: recipients.length,
      frequency: input.frequency,
      nextRunAt,
    },
    'email report created',
  )
  return { report, warnings }
}

interface LockedRow {
  id: string
  company_id: string
  name: string
  kind: string
  campaign_ids: string[] | null
  recipients: string[]
  schedule_cron: string
  timezone: string
  report_window: ReportWindow
  settings: unknown
  enabled: boolean
  next_run_at: Date
}

/**
 * Changes what a PATCH names and keeps the rest; the result is checked as a whole, like a new
 * report. Applies from the next file built: a delivery already queued keeps its file, and goes to
 * the recipients the report has when it is sent.
 */
export async function updateEmailReport(
  deps: EmailReportAdminDeps,
  id: string,
  changes: EmailReportChanges,
): Promise<SavedEmailReport> {
  const now = (deps.now ?? (() => new Date()))()

  const warnings = await deps.db.withTransaction(async (tx) => {
    const [current] = await tx.query<LockedRow>(sql.lock_report, [id])
    if (!current) throw new EmailReportNotFoundError(`email report ${id} does not exist`)

    const storedFrequency = frequencyOf(current.report_window)
    const frequency = changes.frequency ?? storedFrequency
    const cron =
      changes.scheduleCron === undefined
        ? // A report on its frequency's default follows a new frequency to that one's default.
          changes.frequency !== undefined && current.schedule_cron === DEFAULT_CRON[storedFrequency]
          ? DEFAULT_CRON[frequency]
          : current.schedule_cron
        : (changes.scheduleCron ?? DEFAULT_CRON[frequency])
    const timezone = changes.timezone ?? current.timezone
    const enabled = changes.enabled ?? current.enabled
    const campaignIds =
      changes.campaignIds === undefined ? current.campaign_ids : changes.campaignIds
    const recipients =
      changes.recipients === undefined ? current.recipients : checkRecipients(changes.recipients)

    const scheduleChanged =
      cron !== current.schedule_cron ||
      timezone !== current.timezone ||
      (enabled && !current.enabled)
    const nextRunAt = scheduleChanged ? firstRun(cron, timezone, now) : current.next_run_at

    if (changes.campaignIds !== undefined) {
      await checkCampaigns(tx, current.company_id, campaignIds)
    }
    let checked: { settings: Record<string, unknown>; warnings: string[] }
    try {
      checked = await kindOf(current.kind).validate(tx, changes.settings ?? current.settings, {
        companyId: current.company_id,
        campaignIds,
      })
    } catch (cause) {
      if (changes.settings !== undefined || !(cause instanceof InvalidEmailReportError)) throw cause
      throw new InvalidEmailReportError(
        `email report ${id} has no usable settings; pass settings with this change`,
        { cause },
      )
    }

    await tx.query(sql.update_report, [
      id,
      changes.name ?? current.name,
      campaignIds,
      recipients,
      cron,
      timezone,
      windowOf(frequency),
      JSON.stringify(checked.settings),
      enabled,
      nextRunAt,
    ])
    return checked.warnings
  })

  const [report] = await listEmailReports(deps.db, id)
  if (!report) throw new EmailReportNotFoundError(`email report ${id} does not exist`)

  // Which settings changed, by name only: never an address.
  deps.log.info({ emailReportId: id, changed: Object.keys(changes) }, 'email report changed')
  return { report, warnings }
}

/** Trimmed, each an address, none twice (ignoring case), 1–20 of them. Never quotes an address. */
export function checkRecipients(recipients: readonly string[]): string[] {
  const list = recipients.map((address) => address.trim())
  if (list.length === 0) throw new InvalidEmailReportError('a report needs at least one recipient')
  if (list.length > MAX_REPORT_RECIPIENTS) {
    throw new InvalidEmailReportError(
      `a report has at most ${MAX_REPORT_RECIPIENTS} recipients, not ${list.length}`,
    )
  }
  const seen = new Set<string>()
  list.forEach((address, index) => {
    if (!isEmailAddress(address)) {
      throw new InvalidEmailReportError(`recipients[${index}] is not an email address`)
    }
    const key = address.toLowerCase()
    if (seen.has(key)) throw new InvalidEmailReportError(`recipients[${index}] is listed twice`)
    seen.add(key)
  })
  return list
}

function firstRun(cron: string, timezone: string, now: Date): Date {
  try {
    return nextRunAfter(cron, timezone, now)
  } catch (cause) {
    throw new InvalidEmailReportError(
      `scheduleCron '${cron}' is not a cron expression that ever fires in ${timezone}`,
      { cause },
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
  if (!company) throw new InvalidEmailReportError(`company ${companyId} does not exist`)
  const foreign = (campaignIds ?? []).filter((campaign) => !company.owned.includes(campaign))
  if (foreign.length > 0) {
    throw new InvalidEmailReportError(
      `not campaigns of company ${companyId}: ${foreign.join(', ')}`,
    )
  }
}

export async function listEmailReports(db: Db, id?: string): Promise<EmailReportSummary[]> {
  const rows = await db.query<
    LockedRow & {
      company_name: string
      created_at: Date
      last_delivery: EmailReportSummary['lastDelivery']
    }
  >(sql.list_reports, [id ?? null])
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    name: row.name,
    kind: row.kind,
    campaignIds: row.campaign_ids,
    recipients: row.recipients,
    frequency: frequencyOf(row.report_window),
    scheduleCron: row.schedule_cron,
    timezone: row.timezone,
    settings: (row.settings ?? {}) as Record<string, unknown>,
    enabled: row.enabled,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    lastDelivery: row.last_delivery,
  }))
}
