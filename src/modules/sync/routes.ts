import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { daysInclusive } from '../../core/dates.ts'
import { startSync, SyncRunNotFoundError, type SyncDeps } from './engine.ts'
import * as repo from './repo.ts'

// POST /sync/links/:linkId/run and GET /sync/runs/:id (RFC-003 §5), registered inside the /sync
// admin scope, so the bearer check runs first. A trigger answers 202 as soon as the run row exists;
// the fetch and the writes continue in the background and shutdown drains them. Refusals that
// happen before the row exists come back as 4xx through the root error handler: 404 unknown link,
// 409 disabled link or a run in progress, 422 invalid link config, 429 inside the cooldown.

/** Longer ranges are backfills for the CLI; this stops a typo from queueing years of API calls. */
export const MAX_ROUTE_WINDOW_DAYS = 366

const isCalendarDate = (value: string): boolean => z.iso.date().safeParse(value).success

const linkParams = z.object({ linkId: z.guid() })
const runParams = z.object({ id: z.guid() })

const triggerBody = z
  .strictObject({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    dryRun: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    const { from, to } = body
    if (from === undefined && to === undefined) return
    if (from === undefined || to === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'pass both from and to, or neither for the source lookback',
      })
      return
    }
    // A malformed date already carries its own issue; comparing or counting days on it would throw.
    if (!isCalendarDate(from) || !isCalendarDate(to)) return
    if (from > to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'to is before from' })
    } else if (daysInclusive(from, to) > MAX_ROUTE_WINDOW_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `at most ${MAX_ROUTE_WINDOW_DAYS} days; use the CLI for longer backfills`,
      })
    }
  })
  // A POST with no body at all arrives as null, not undefined: a trigger without options is fine.
  .nullish()

type TriggerBody = NonNullable<z.infer<typeof triggerBody>>

const accepted = z.object({ syncRunId: z.guid() })

const runResponse = z.object({
  id: z.guid(),
  linkId: z.guid(),
  trigger: z.enum(['cron', 'manual', 'backfill']),
  dryRun: z.boolean(),
  status: z.enum(['running', 'succeeded', 'failed']),
  window: z.object({ from: z.iso.date(), to: z.iso.date() }),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  daysWritten: z.number().nullable(),
  rowsWritten: z.number().nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
})

export const syncRoutes: FastifyPluginAsync<{ deps: SyncDeps }> = async (app, { deps }) => {
  app.post<{ Params: z.infer<typeof linkParams>; Body: TriggerBody | null | undefined }>(
    '/links/:linkId/run',
    { schema: { params: linkParams, body: triggerBody, response: { 202: accepted } } },
    async (request, reply) => {
      const body: TriggerBody = request.body ?? {}
      const window =
        body.from !== undefined && body.to !== undefined
          ? { from: body.from, to: body.to }
          : undefined
      const { syncRunId } = await startSync(deps, {
        linkId: request.params.linkId,
        ...(window ? { window } : {}),
        trigger: 'manual',
        dryRun: body.dryRun ?? false,
        // Phase 1 has one shared operator token, so there is no user to attribute the run to.
        triggeredBy: null,
      })
      return reply.code(202).send({ syncRunId })
    },
  )

  app.get<{ Params: z.infer<typeof runParams> }>(
    '/runs/:id',
    { schema: { params: runParams, response: { 200: runResponse } } },
    async (request) => {
      const run = await repo.loadRun(deps.db, request.params.id)
      if (!run) throw new SyncRunNotFoundError(`sync run ${request.params.id} does not exist`)
      return run
    },
  )
}
