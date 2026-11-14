import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { daysInclusive } from '../../core/dates.ts'
import { ianaTimezone } from '../../core/schemas.ts'
import { FREQUENCIES } from '../webhooks/periods.ts'
import { MAX_PERIOD_DAYS } from '../webhooks/routes.ts'
import {
  createEmailReport,
  listEmailReports,
  MAX_REPORT_RECIPIENTS,
  updateEmailReport,
} from './admin.ts'
import { KIND_NAMES } from './kinds/index.ts'
import { previewEmail, sendNow, type EmailReportServiceDeps } from './send.ts'

// The /email-reports admin scope; the bearer check runs first.
//
// GET   /email-reports               every report, its recipients and how its last email went
// POST  /email-reports               creates one; 422 mail_not_configured while email is off
// PATCH /email-reports/:id           changes any setting but the company and the kind; omitted
//                                    keys stay as they are; recipients is the whole list
// POST  /email-reports/:id/preview   the email a period would be: subject, text, file name and the
//                                    file; stores and sends nothing, works with email off
// POST  /email-reports/:id/send-now  any range of days now: re-queues the period's pending or
//                                    failed delivery, or creates a new one (also for a period
//                                    already delivered); answers 202 and tries once in the
//                                    background
//
// There is no delete: a report is switched off with enabled: false. Refusals come back through the
// root error handler: 404 unknown report, 409 disabled or a period without rows, 422 a report that
// could never work or email off, 400 a malformed body.

const isCalendarDate = (value: string): boolean => z.iso.date().safeParse(value).success

const reportParams = z.object({ id: z.guid() })

/** A period for send-now and preview; neither = the report's own period, as of now. */
const periodBody = z
  .strictObject({
    period_start: z.iso.date().optional(),
    period_end: z.iso.date().optional(),
  })
  .superRefine((body, ctx) => {
    const { period_start: from, period_end: to } = body
    if (from === undefined && to === undefined) return
    if (from === undefined || to === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['period_start'],
        message: 'pass both period_start and period_end, or neither for the report period',
      })
      return
    }
    if (!isCalendarDate(from) || !isCalendarDate(to)) return
    if (from > to) {
      ctx.addIssue({
        code: 'custom',
        path: ['period_end'],
        message: 'period_end is before period_start',
      })
    } else if (daysInclusive(from, to) > MAX_PERIOD_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['period_end'],
        message: `at most ${MAX_PERIOD_DAYS} days`,
      })
    }
  })
  // A POST with no body at all arrives as null: an empty send-now is legitimate.
  .nullish()

type PeriodBody = NonNullable<z.infer<typeof periodBody>>

const periodOf = (body: PeriodBody | null | undefined) =>
  body?.period_start !== undefined && body.period_end !== undefined
    ? { from: body.period_start, to: body.period_end }
    : undefined

const name = z.string().trim().min(1).max(200)
/** Checked again by the service: each an address, none twice. */
const recipients = z.array(z.string().trim().min(3).max(254)).min(1).max(MAX_REPORT_RECIPIENTS)
/** Five-field cron, evaluated in `timezone`: '0 3 * * *' = every day at 03:00. */
const cron = z.string().trim().min(1).max(100)
const campaignIds = z.array(z.guid()).min(1).max(500)
/** Per kind, checked by it; rows: { format: 'csv' | 'json', fields: a webhook column list }. */
const settings = z.record(z.string(), z.unknown())

const summary = z.object({
  id: z.guid(),
  companyId: z.guid(),
  companyName: z.string(),
  name: z.string(),
  kind: z.string(),
  campaignIds: z.array(z.guid()).nullable(),
  recipients: z.array(z.string()),
  frequency: z.enum(FREQUENCIES),
  scheduleCron: z.string(),
  timezone: z.string(),
  settings: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  nextRunAt: z.date(),
  createdAt: z.date(),
  lastDelivery: z
    .object({
      id: z.guid(),
      trigger: z.enum(['schedule', 'manual']),
      status: z.enum(['pending', 'delivered', 'failed']),
      periodStart: z.iso.date(),
      periodEnd: z.iso.date(),
      attempts: z.number(),
      lastAttemptAt: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
})

const createBody = z.strictObject({
  companyId: z.guid(),
  name,
  /** Left out: rows. */
  kind: z.enum(KIND_NAMES).optional(),
  recipients,
  /** Left out or null: every campaign of the company, including ones created later. */
  campaignIds: campaignIds.nullable().optional(),
  /** Which period an email covers: the previous day, ISO week or calendar month. */
  frequency: z.enum(FREQUENCIES),
  /** Left out: 05:00 every day, Monday or 1st of the month, as the frequency goes. */
  scheduleCron: cron.optional(),
  timezone: ianaTimezone.optional(),
  settings,
  enabled: z.boolean().optional(),
})

const patchBody = z
  .strictObject({
    name: name.optional(),
    recipients: recipients.optional(),
    campaignIds: campaignIds.nullable().optional(),
    frequency: z.enum(FREQUENCIES).optional(),
    /** null: the default for the frequency. */
    scheduleCron: cron.nullable().optional(),
    timezone: ianaTimezone.optional(),
    settings: settings.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'nothing to change' })

const saved = z.object({ report: summary, warnings: z.array(z.string()) })

const preview = z.object({
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  rowCount: z.int().nonnegative(),
  recipients: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  attachment: z.object({ filename: z.string(), contentType: z.string() }),
  /** Exactly the file a delivery would attach. */
  document: z.string(),
})

const accepted = z.object({
  deliveryId: z.guid(),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
})

export const emailReportRoutes: FastifyPluginAsync<{ deps: EmailReportServiceDeps }> = async (
  app,
  { deps },
) => {
  app.get('/', { schema: { response: { 200: z.array(summary) } } }, async () =>
    listEmailReports(deps.db),
  )

  app.post<{ Body: z.infer<typeof createBody> }>(
    '/',
    { schema: { body: createBody, response: { 201: saved } } },
    async (request, reply) => reply.code(201).send(await createEmailReport(deps, request.body)),
  )

  app.patch<{ Params: z.infer<typeof reportParams>; Body: z.infer<typeof patchBody> }>(
    '/:id',
    { schema: { params: reportParams, body: patchBody, response: { 200: saved } } },
    async (request) => updateEmailReport(deps, request.params.id, request.body),
  )

  app.post<{ Params: z.infer<typeof reportParams>; Body: PeriodBody | null | undefined }>(
    '/:id/preview',
    { schema: { params: reportParams, body: periodBody, response: { 200: preview } } },
    async (request) => {
      const period = periodOf(request.body)
      const result = await previewEmail(deps, {
        reportId: request.params.id,
        ...(period ? { period } : {}),
      })
      return {
        periodStart: result.period.from,
        periodEnd: result.period.to,
        rowCount: result.rowCount,
        recipients: result.recipients,
        subject: result.subject,
        text: result.text,
        attachment: result.attachment,
        document: result.document,
      }
    },
  )

  app.post<{ Params: z.infer<typeof reportParams>; Body: PeriodBody | null | undefined }>(
    '/:id/send-now',
    { schema: { params: reportParams, body: periodBody, response: { 202: accepted } } },
    async (request, reply) => {
      const period = periodOf(request.body)
      const result = await sendNow(deps, {
        reportId: request.params.id,
        ...(period ? { period } : {}),
      })
      return reply.code(202).send({
        deliveryId: result.deliveryId,
        periodStart: result.period.from,
        periodEnd: result.period.to,
      })
    },
  )
}
