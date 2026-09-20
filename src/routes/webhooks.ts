import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { daysInclusive } from '../dates.ts'
import type { SendDeps } from '../webhooks/send.ts'
import { sendNow } from '../webhooks/send.ts'

// POST /webhooks/:id/send-now (RFC-002 §15.3), registered inside the /webhooks admin scope, so the
// bearer check runs first. It enqueues the delivery — or re-queues the one this period already has
// — answers 202 with its id, and tries once in the background. Refusals come back through the root
// error handler: 404 unknown webhook, 409 disabled or already delivered, 400 a bad period.

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

export const webhookRoutes: FastifyPluginAsync<{ deps: SendDeps }> = async (app, { deps }) => {
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
