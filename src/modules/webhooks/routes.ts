import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { daysInclusive } from '../../core/dates.ts'
import { ianaTimezone } from '../../core/schemas.ts'
import { createWebhook, listWebhooks, updateWebhook } from './admin.ts'
import { findExport, type ExportDeps } from './exports.ts'
import { payloadFieldsSchema } from './fields.ts'
import { FORMATS } from './payload.ts'
import { FREQUENCIES } from './periods.ts'
import type { SendDeps } from './send.ts'
import { previewPayload, sendNow } from './send.ts'

// The /webhooks admin scope (RFC-002 §15.3); the bearer check runs first.
//
// GET   /webhooks               what is configured and how each last delivery went — never a secret
// POST  /webhooks               creates one; the signing secret is in this response and nowhere else
// PATCH /webhooks/:id           changes any setting but the company; omitted keys stay as they are
// POST  /webhooks/:id/preview   the document a delivery of a period would carry; stores and sends
//                               nothing
// POST  /webhooks/:id/send-now  any range of days, in the webhook's format: re-queues the period's
//                               pending or failed delivery, or enqueues a new one (also for a
//                               period already delivered); answers 202 with its id, and tries once
//                               in the background
//
// Refusals come back through the root error handler: 404 unknown webhook, 409 disabled or a
// period without rows, 422 a schedule, target, campaign, key or formula that could never work, 400
// a malformed body.

/** A hand-picked period is a report, not a backfill. */
export const MAX_PERIOD_DAYS = 366

const isCalendarDate = (value: string): boolean => z.iso.date().safeParse(value).success

const webhookParams = z.object({ id: z.guid() })

/** A period for send-now and preview; neither = the webhook's own frequency, as of now. */
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
        message: 'pass both period_start and period_end, or neither for the webhook period',
      })
      return
    }
    // A malformed date already carries its own issue; comparing or counting days on it would throw.
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
  // A POST with no body at all arrives as null, not undefined: an empty send-now is legitimate.
  .nullish()

type PeriodBody = NonNullable<z.infer<typeof periodBody>>

const periodOf = (body: PeriodBody | null | undefined) =>
  body?.period_start !== undefined && body.period_end !== undefined
    ? { from: body.period_start, to: body.period_end }
    : undefined

const accepted = z.object({
  deliveryId: z.guid(),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
})

const webhookSummary = z.object({
  id: z.guid(),
  companyId: z.guid(),
  companyName: z.string(),
  name: z.string(),
  url: z.string(),
  campaignIds: z.array(z.guid()).nullable(),
  frequency: z.enum(FREQUENCIES),
  scheduleCron: z.string(),
  timezone: z.string(),
  format: z.enum(FORMATS),
  /** The header the client's key goes in. The key itself is never in a response. */
  auth: z.strictObject({ header: z.string() }).nullable(),
  enabled: z.boolean(),
  nextRunAt: z.date(),
  createdAt: z.date(),
  /** As stored; loose here so one row edited by hand cannot break the whole list. */
  fields: z.record(z.string(), z.unknown()).nullable(),
  lastDelivery: z
    .object({
      id: z.guid(),
      status: z.enum(['pending', 'delivered', 'failed']),
      periodStart: z.iso.date(),
      periodEnd: z.iso.date(),
      attempts: z.number(),
      responseCode: z.number().nullable(),
    })
    .nullable(),
})

/** The client's own key for its endpoint, e.g. the token of a Funnel File Import. Write-only. */
const authBody = z.strictObject({
  /** Lowercase; default `authorization` (json) or `x-funnel-fileimport-token` (csv). */
  header: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{1,64}$/, 'a header name: letters, digits and -')
    .optional(),
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\p{Cc}]+$/u, 'no control characters or line breaks'),
})

const name = z.string().trim().min(1).max(200)
/** Must be public HTTPS; checked against DNS before it is saved. */
const url = z.string().trim().min(1).max(2000)
/** Five-field cron, evaluated in `timezone`: '0 5 * * 1' = Mondays 05:00. */
const cron = z.string().trim().min(1).max(100)
const campaignIds = z.array(z.guid()).min(1).max(500)

const createBody = z.strictObject({
  companyId: z.guid(),
  name,
  url,
  /** Left out or null: every campaign of the company, including ones created later. */
  campaignIds: campaignIds.nullable().optional(),
  /** Which period a report covers: the previous day, ISO week or calendar month. */
  frequency: z.enum(FREQUENCIES),
  /** Left out: 05:00 every day, Monday or 1st of the month, as the frequency goes. */
  scheduleCron: cron.optional(),
  timezone: ianaTimezone.optional(),
  /** Left out: json. */
  format: z.enum(FORMATS).optional(),
  auth: authBody.optional(),
  /** The columns after Date and Campaign (src/modules/webhooks/fields.ts). */
  fields: payloadFieldsSchema,
  enabled: z.boolean().optional(),
})

const created = z.object({
  webhook: webhookSummary,
  secret: z.string(),
  warnings: z.array(z.string()),
})

const patchBody = z
  .strictObject({
    name: name.optional(),
    url: url.optional(),
    /** null: every campaign of the company. */
    campaignIds: campaignIds.nullable().optional(),
    frequency: z.enum(FREQUENCIES).optional(),
    /** null: the default for the frequency. */
    scheduleCron: cron.nullable().optional(),
    timezone: ianaTimezone.optional(),
    format: z.enum(FORMATS).optional(),
    /** null: send no key (json only). */
    auth: authBody.nullable().optional(),
    fields: payloadFieldsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'nothing to change' })

const updated = z.object({ webhook: webhookSummary, warnings: z.array(z.string()) })

const preview = z.object({
  format: z.enum(FORMATS),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  rowCount: z.int().nonnegative(),
  /** Exactly what a delivery would store: the JSON body (delivery_id null) or the CSV file. */
  document: z.string(),
})

export const webhookRoutes: FastifyPluginAsync<{ deps: SendDeps }> = async (app, { deps }) => {
  app.get('/', { schema: { response: { 200: z.array(webhookSummary) } } }, async () =>
    listWebhooks(deps.db),
  )

  app.post<{ Body: z.infer<typeof createBody> }>(
    '/',
    { schema: { body: createBody, response: { 201: created } } },
    async (request, reply) => reply.code(201).send(await createWebhook(deps, request.body)),
  )

  app.patch<{ Params: z.infer<typeof webhookParams>; Body: z.infer<typeof patchBody> }>(
    '/:id',
    { schema: { params: webhookParams, body: patchBody, response: { 200: updated } } },
    async (request) => updateWebhook(deps, request.params.id, request.body),
  )

  app.post<{ Params: z.infer<typeof webhookParams>; Body: PeriodBody | null | undefined }>(
    '/:id/preview',
    { schema: { params: webhookParams, body: periodBody, response: { 200: preview } } },
    async (request) => {
      const period = periodOf(request.body)
      const result = await previewPayload(deps, {
        webhookId: request.params.id,
        ...(period ? { period } : {}),
      })
      return {
        format: result.format,
        periodStart: result.period.from,
        periodEnd: result.period.to,
        rowCount: result.rowCount,
        document: result.document,
      }
    },
  )

  app.post<{ Params: z.infer<typeof webhookParams>; Body: PeriodBody | null | undefined }>(
    '/:id/send-now',
    { schema: { params: webhookParams, body: periodBody, response: { 202: accepted } } },
    async (request, reply) => {
      const period = periodOf(request.body)
      const result = await sendNow(deps, {
        webhookId: request.params.id,
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

// The public /exports scope (src/app.ts): a csv webhook's file, behind its signed link. Every
// refusal is the same 404. The query string carries the signature, so Fastify's own request lines
// are off for this route (errors still log); each answer is logged here, by delivery id only.
export const exportRoutes: FastifyPluginAsync<{ deps: ExportDeps }> = async (app, { deps }) => {
  const log = deps.log.child({ component: 'csv-export' })

  app.get<{ Params: { file: string }; Querystring: Record<string, unknown> }>(
    '/:file',
    { logLevel: 'warn' },
    async (request, reply) => {
      const now = (deps.now ?? (() => new Date()))()
      const found = await findExport(deps.db, request.params.file, request.query, now)
      if (!found.found) {
        log.info(
          { reason: found.reason, ...(found.deliveryId ? { deliveryId: found.deliveryId } : {}) },
          'csv export refused',
        )
        return reply.code(404).send({ error: 'not_found' })
      }

      log.info({ deliveryId: found.deliveryId, webhookId: found.webhookId }, 'csv export fetched')
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${found.deliveryId}.csv"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(found.csv)
    },
  )
}
