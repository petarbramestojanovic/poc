import { CronExpressionParser } from 'cron-parser'
import { schedule as cronSchedule, type TaskOptions } from 'node-cron'
import { limitDb, type LeaderLease } from '../db.ts'
import { createLimiter } from '../limiter.ts'
import type { Logger } from '../log.ts'
import { deliverOnce, type DeliverDeps } from './deliver.ts'
import { reportPeriod } from './periods.ts'
import * as repo from './repo.ts'

// The minutely tick that drives webhooks (RFC-002 §15.2): one tick, not a timer per webhook.
// Every replica schedules it; the leader lock lets exactly one of them do the work. A tick does
// two things in order:
//   1. enqueue — every webhook whose next_run_at has come gets a delivery row for its period, and
//      its schedule moves to the next occurrence, both in one transaction;
//   2. deliver — every pending delivery that is due gets one attempt.
// Dispatch is next_run_at-driven, so a tick missed during a deploy is picked up by the next one:
// the row is still due. A gap of days still produces ONE report, for the current period.

/** Second key of the webhook leader lock; the nightly pass holds key 1. */
export const WEBHOOK_LEADER_LOCK_KEY = 2

export const WEBHOOK_TICK_CRON = '* * * * *'

/** Ceilings per tick, so one backlog cannot hold the lock (or the pool) for minutes. */
const MAX_WEBHOOKS_PER_TICK = 50
const MAX_DELIVERIES_PER_TICK = 10

/** RFC-002 §15.1: webhooks are batch work and never take more than their share of the pool. */
const WEBHOOK_MAX_CONNECTIONS = 2

/** How far a webhook with an unparseable cron is pushed out, so it is not retried every minute. */
const BAD_CRON_RETRY_MS = 3_600_000

export type WebhookDeps = DeliverDeps

export interface EnqueueResult {
  /** Deliveries created; a period that already had a row is not counted. */
  enqueued: number
  /** Webhooks looked at, including those whose period was already enqueued. */
  due: number
}

export interface DeliverResult {
  attempted: number
  delivered: number
}

export interface WebhookTickResult {
  acquired: boolean
  enqueue?: EnqueueResult
  deliver?: DeliverResult
}

/** The next time `cron` fires in `timezone`, strictly after `after`. */
export function nextRunAfter(cron: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate()
}

/**
 * Creates the delivery rows for every due webhook and moves their schedules on. One transaction:
 * the rows are selected FOR UPDATE SKIP LOCKED, so nothing else can enqueue the same period, and
 * a crash before COMMIT leaves both the row and the schedule untouched.
 */
export async function enqueueDueWebhooks(
  deps: WebhookDeps,
  lease?: LeaderLease,
): Promise<EnqueueResult> {
  const now = (deps.now ?? (() => new Date()))()
  await lease?.assertHeld()

  return deps.db.withTransaction(async (tx) => {
    const due = await repo.loadDueWebhooks(tx, now, MAX_WEBHOOKS_PER_TICK)
    let enqueued = 0

    for (const webhook of due) {
      const log = deps.log.child({ webhookId: webhook.id, webhook: webhook.name })
      let next: Date
      try {
        next = nextRunAfter(webhook.scheduleCron, webhook.timezone, now)
      } catch (error) {
        // An unusable schedule must not stall the tick or shout every minute.
        log.error({ err: error }, 'webhook schedule cannot be parsed; postponing')
        await repo.updateNextRun(tx, webhook.id, new Date(now.getTime() + BAD_CRON_RETRY_MS))
        continue
      }

      const period = reportPeriod(webhook.reportWindow, webhook.timezone, now)
      const deliveryId = await repo.insertDelivery(tx, webhook.id, period, 'schedule')
      await repo.updateNextRun(tx, webhook.id, next)

      if (deliveryId === undefined) {
        log.info({ period }, 'webhook period already enqueued')
      } else {
        enqueued += 1
        log.info({ period, deliveryId, nextRunAt: next }, 'webhook delivery enqueued')
      }
    }

    return { enqueued, due: due.length }
  })
}

/** One attempt for each pending delivery that is due, oldest first. */
export async function deliverDueDeliveries(deps: WebhookDeps): Promise<DeliverResult> {
  const now = (deps.now ?? (() => new Date()))()
  const due = await repo.loadDueDeliveries(deps.db, now, MAX_DELIVERIES_PER_TICK)
  const result: DeliverResult = { attempted: 0, delivered: 0 }

  for (const delivery of due) {
    // Shutdown stops the queue where it is; the rows stay pending and the next tick resumes.
    if (deps.signal?.aborted) break
    const outcome = await deliverOnce(deps, delivery)
    result.attempted += 1
    if (outcome.delivered) result.delivered += 1
  }
  return result
}

/** One full tick, behind the leader lock. Returns `acquired: false` when another replica has it. */
export async function runWebhookTick(deps: WebhookDeps): Promise<WebhookTickResult> {
  // The tick's own share of the pool: the leader lock keeps its dedicated connection outside it.
  const limited: WebhookDeps = {
    ...deps,
    db: limitDb(deps.db, createLimiter(WEBHOOK_MAX_CONNECTIONS)),
  }
  const locked = await deps.db.withAdvisoryLock(WEBHOOK_LEADER_LOCK_KEY, async (lease) => {
    const enqueue = await enqueueDueWebhooks(limited, lease)
    const deliver = await deliverDueDeliveries(limited)
    return { enqueue, deliver }
  })

  if (!locked.acquired) {
    deps.log.debug('webhook tick skipped: another process holds the leader lock')
    return { acquired: false }
  }
  return { acquired: true, ...locked.result }
}

export interface WebhookScheduler {
  /** Stops future ticks and waits for a tick that is already running. */
  stop(): Promise<void>
}

type Schedule = (
  expression: string,
  task: () => Promise<void>,
  options: TaskOptions,
) => { stop(): void | Promise<void> }

export interface WebhookSchedulerOptions {
  /** Injectable for tests; defaults to node-cron's schedule. */
  schedule?: Schedule
}

export function startWebhookScheduler(
  deps: WebhookDeps,
  options: WebhookSchedulerOptions = {},
): WebhookScheduler {
  const schedule: Schedule = options.schedule ?? cronSchedule
  const log = deps.log.child({ component: 'webhook-scheduler' })
  let running: Promise<void> | undefined

  async function tick(): Promise<void> {
    try {
      await runWebhookTick({ ...deps, log })
    } catch (error) {
      // A failed tick is logged and forgotten; the next minute starts clean.
      log.error({ err: error }, 'webhook tick failed')
    }
  }

  const task = schedule(
    WEBHOOK_TICK_CRON,
    () => {
      running ??= tick().finally(() => {
        running = undefined
      })
      return running
    },
    {
      name: 'webhook-tick',
      // The tick is timezone-free: every webhook carries its own timezone.
      timezone: 'UTC',
      noOverlap: true,
      logger: cronLogger(log),
    },
  )
  log.info({ cron: WEBHOOK_TICK_CRON }, 'webhook scheduler started')

  return {
    async stop() {
      await task.stop()
      await running
    },
  }
}

/** node-cron's own messages go through pino, not the console. */
function cronLogger(log: Logger): NonNullable<TaskOptions['logger']> {
  const text = (message: string | Error) =>
    typeof message === 'string' ? message : message.message
  return {
    info: (message) => {
      log.info(message)
    },
    warn: (message) => {
      log.warn(message)
    },
    error: (message, err) => {
      log.error({ err: err ?? message }, text(message))
    },
    debug: (message, err) => {
      log.debug({ err }, text(message))
    },
  }
}
