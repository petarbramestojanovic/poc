import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { daysInclusive } from '../dates.ts'
import { ianaTimezone } from '../schemas.ts'
import { createWebhook, listWebhooks } from '../webhooks/admin.ts'
import { REPORT_WINDOWS } from '../webhooks/periods.ts'
import type { SendDeps } from '../webhooks/send.ts'
import { sendNow } from '../webhooks/send.ts'

// The /webhooks admin scope (RFC-002 §15.3); the bearer check runs first.
//
// GET  /webhooks               what is configured and how each last delivery went — never a secret
// POST /webhooks               creates one; the signing secret is in this response and nowhere else
// POST /webhooks/:id/send-now  enqueues the delivery — or re-queues the one this period already
//                              has — answers 202 with its id, and tries once in the background
//
// Refusals come back through the root error handler: 404 unknown webhook, 409 disabled or already
// delivered, 422 a schedule, target or campaign that could never work, 400 a malformed body.

/** A hand-picked period is a report, not a backfill. */
export const MAX_PERIOD_DAYS = 366

const isCalendarDate = (value: string): boolean => z.iso.date().safeParse(value).success

const webhookParams = z.object({ id: z.guid() })

const sendNowBody = z
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
        message: 'pass both period_start and period_end, or neither for the webhook window',
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

type SendNowBody = NonNullable<z.infer<typeof sendNowBody>>

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
  scheduleCron: z.string(),
  timezone: z.string(),
  reportWindow: z.enum(REPORT_WINDOWS),
  includeCheckSources: z.boolean(),
  includeCreatives: z.boolean(),
  enabled: z.boolean(),
  nextRunAt: z.date(),
  createdAt: z.date(),
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

const createBody = z.strictObject({
  companyId: z.guid(),
  name: z.string().trim().min(1).max(200),
  /** Must be public HTTPS; checked against DNS before it is saved. */
  url: z.string().trim().min(1).max(2000),
  /** Left out or null: every campaign of the company, including ones created later. */
  campaignIds: z.array(z.guid()).min(1).max(500).nullable().optional(),
  /** Five-field cron, evaluated in `timezone`: '0 8 * * 1' = Mondays 08:00. */
  scheduleCron: z.string().trim().min(1).max(100),
  timezone: ianaTimezone.optional(),
  reportWindow: z.enum(REPORT_WINDOWS).optional(),
  includeCheckSources: z.boolean().optional(),
  includeCreatives: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

const created = z.object({
  webhook: webhookSummary,
  secret: z.string(),
  warnings: z.array(z.string()),
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

  app.post<{ Params: z.infer<typeof webhookParams>; Body: SendNowBody | null | undefined }>(
    '/:id/send-now',
    { schema: { params: webhookParams, body: sendNowBody, response: { 202: accepted } } },
    async (request, reply) => {
      const body: SendNowBody = request.body ?? {}
      const period =
        body.period_start !== undefined && body.period_end !== undefined
          ? { from: body.period_start, to: body.period_end }
          : undefined

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
