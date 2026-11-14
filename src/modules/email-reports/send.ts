import { randomUUID } from 'node:crypto'
import type { Db } from '../../core/db.ts'
import type { DateWindow } from '../../core/dates.ts'
import type { Logger } from '../../core/log.ts'
import { MailNotConfiguredError } from '../../core/mail/errors.ts'
import type { Mailer } from '../../core/mail/types.ts'
import type { RunTracker } from '../sync/engine.ts'
import { leaseUntil } from '../webhooks/deliver.ts'
import { reportPeriod } from '../webhooks/periods.ts'
import { emailFor } from './content.ts'
import { deliverOnce } from './deliver.ts'
import {
  EmailReportDisabledError,
  EmailReportNotFoundError,
  EmptyEmailPeriodError,
} from './errors.ts'
import { kindOf } from './kinds/index.ts'
import * as repo from './repo.ts'

// POST /email-reports/:id/send-now: an email of any range of days now, to test a report or send a
// period again. POST /email-reports/:id/preview: what that email would be, built the same way and
// stored and sent nowhere. Neither waits for incomplete data: a person asked for this period now.
//
// What send-now does depends on the period's latest delivery, as for webhooks:
//   pending or failed  re-queued under its own id with a rebuilt file, the ladder back at zero;
//   delivered          a NEW delivery with a new id, so the record of the first one stays;
//   none               a new delivery.
// A period without rows is refused, as the schedule would skip it.

export interface EmailReportServiceDeps {
  db: Db
  /** Unset when MAIL_PROVIDER is not: reports can be listed, changed and previewed, not sent. */
  mailer?: Mailer | undefined
  log: Logger
  now?: () => Date
  /** Shutdown: cancels an immediate attempt in flight. */
  signal?: AbortSignal
  /** In-flight attempts; app.close() waits for them. */
  tracker?: RunTracker
}

export interface SendNowRequest {
  reportId: string
  /** Defaults to the report's own frequency, as of now. */
  period?: DateWindow
  /** False only enqueues, leaving the attempt to the next tick (tests use it). */
  deliverNow?: boolean
}

export interface SendNowResult {
  deliveryId: string
  period: DateWindow
}

export async function sendNow(
  deps: EmailReportServiceDeps,
  request: SendNowRequest,
): Promise<SendNowResult> {
  const { mailer } = deps
  if (mailer === undefined) throw new MailNotConfiguredError()
  const now = (deps.now ?? (() => new Date()))()
  const report = await repo.loadReport(deps.db, request.reportId)
  if (!report) throw new EmailReportNotFoundError(`email report ${request.reportId} does not exist`)
  if (!report.enabled) throw new EmailReportDisabledError(`email report ${report.id} is disabled`)

  const prepared = kindOf(report.kind).prepare(report.settings)
  const period = request.period ?? reportPeriod(report.frequency, report.timezone, now)

  const deliveryId = await deps.db.withTransaction(async (tx) => {
    const latest = await repo.loadDeliveryForPeriod(tx, report.id, period)
    if (latest && latest.status !== 'delivered') {
      // Rebuilt with the id it keeps: the numbers may have moved on since it failed.
      const built = await prepared.build(tx, report, period, latest.id, now, deps.log)
      if (built.rowCount === 0) throw emptyPeriod(report.id, period)
      const requeued = await repo.requeueDelivery(tx, latest.id, built.document, built.contentType)
      // Delivered by an attempt in flight since the read: send the period again, as below.
      if (requeued !== undefined) return requeued
    }

    const id = randomUUID()
    const built = await prepared.build(tx, report, period, id, now, deps.log)
    if (built.rowCount === 0) throw emptyPeriod(report.id, period)
    // A manual row never conflicts (insert_delivery.sql), so the insert always lands.
    const inserted = await repo.insertDelivery(tx, {
      id,
      reportId: report.id,
      period,
      trigger: 'manual',
      document: built.document,
      contentType: built.contentType,
    })
    if (inserted === undefined) throw new Error(`manual email delivery ${id} was not inserted`)
    return inserted
  })

  const log = deps.log.child({ emailReportId: report.id, deliveryId })
  log.info({ period }, 'email report delivery queued by hand')
  if (request.deliverNow !== false) attemptInBackground({ ...deps, mailer, log }, deliveryId)
  return { deliveryId, period }
}

function emptyPeriod(reportId: string, period: DateWindow): EmptyEmailPeriodError {
  return new EmptyEmailPeriodError(
    `no campaign of email report ${reportId} has a number in ${period.from}..${period.to}`,
  )
}

export interface PreviewRequest {
  reportId: string
  /** Defaults to the report's own frequency, as of now. */
  period?: DateWindow
}

export interface Preview {
  period: DateWindow
  rowCount: number
  recipients: string[]
  subject: string
  text: string
  attachment: { filename: string; contentType: string }
  /** The exact file a delivery would attach (a JSON document has delivery_id null here). */
  document: string
}

/**
 * The email a delivery of this period would be. Nothing is stored or sent, and it works with email
 * off and for a disabled report, so a report can be checked before anyone receives it. An empty
 * period previews as a file with the header only, though the schedule would send nothing.
 */
export async function previewEmail(
  deps: EmailReportServiceDeps,
  request: PreviewRequest,
): Promise<Preview> {
  const now = (deps.now ?? (() => new Date()))()
  const report = await repo.loadReport(deps.db, request.reportId)
  if (!report) throw new EmailReportNotFoundError(`email report ${request.reportId} does not exist`)

  const prepared = kindOf(report.kind).prepare(report.settings)
  const period = request.period ?? reportPeriod(report.frequency, report.timezone, now)
  const built = await prepared.build(deps.db, report, period, null, now, deps.log)
  const email = emailFor(report, report.recipients, period, built.document, built.contentType)
  const [attachment] = email.attachments
  return {
    period,
    rowCount: built.rowCount,
    recipients: report.recipients,
    subject: email.subject,
    text: email.text,
    attachment: { filename: attachment?.filename ?? '', contentType: built.contentType },
    document: built.document,
  }
}

/**
 * Tries once, right away, so a person sees the result in seconds instead of at the next tick. A
 * failure is an ordinary attempt, recorded on the row; the tick picks up the retry. It claims the
 * row like a tick does, so the two never send it at once.
 */
function attemptInBackground(
  deps: EmailReportServiceDeps & { mailer: Mailer },
  deliveryId: string,
): void {
  const attempt = (async () => {
    const now = (deps.now ?? (() => new Date()))()
    const delivery = await repo.claimDelivery(deps.db, deliveryId, now, leaseUntil(now))
    if (delivery) await deliverOnce(deps, delivery)
  })().catch((error: unknown) => {
    deps.log.error({ err: error, deliveryId }, 'immediate email report delivery failed')
  })
  if (deps.tracker) void deps.tracker.track(attempt)
}
