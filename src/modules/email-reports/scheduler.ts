import { randomUUID } from 'node:crypto'
import { schedule as cronSchedule, type TaskOptions } from 'node-cron'
import { limitDb, type LeaderLease } from '../../core/db.ts'
import { createLimiter } from '../../core/limiter.ts'
import type { Logger } from '../../core/log.ts'
import { leaseUntil } from '../webhooks/deliver.ts'
import { reportPeriod } from '../webhooks/periods.ts'
import { nextRunAfter, waitDeadline } from '../webhooks/scheduler.ts'
import { deliverOnce, type DeliverDeps } from './deliver.ts'
import { kindOf, type PreparedReport } from './kinds/index.ts'
import * as repo from './repo.ts'

// The minutely tick that drives email reports, beside the webhook tick and built the same way:
// every replica schedules it, the leader lock (key 3) lets one of them do the work, and a tick
//   1. enqueues: every report whose next_run_at has come gets a delivery row for its period, with
//      the file it will attach, and its schedule moves on, both in one transaction;
//   2. delivers: every pending delivery that is due gets one attempt (deliver.ts).
// A report waits for its data like a webhook: while a campaign it covers is not synced through the
// period, it stays due, until 12:00 in its timezone on the day it was due, when it goes out with
// what there is. A period without a single number is not sent.

/** Second key of this tick's leader lock: the nightly pass holds 1, the webhook tick 2. */
export const EMAIL_REPORT_LEADER_LOCK_KEY = 3

export const EMAIL_REPORT_TICK_CRON = '* * * * *'

/** Ceilings per tick, so one backlog cannot hold the lock (or the pool) for minutes. */
const MAX_REPORTS_PER_TICK = 50
const MAX_DELIVERIES_PER_TICK = 10

/**
 * This tick's share of the pool. One is enough: enqueueing runs inside one transaction, and
 * delivering is one statement at a time around each send.
 */
const EMAIL_REPORT_MAX_CONNECTIONS = 1

/** How far a report whose schedule or settings cannot be read is pushed out (a row edited by hand). */
const BAD_CONFIG_RETRY_MS = 3_600_000

export type EmailReportDeps = DeliverDeps

export interface EnqueueResult {
  /** Deliveries created; a period that already had a row is not counted. */
  enqueued: number
  /** Reports looked at. */
  due: number
  /** Due reports left due because their data is not complete yet. */
  waiting: number
  /** Periods with no rows: nothing was sent, and the schedule moved on. */
  empty: number
}

export interface DeliverResult {
  attempted: number
  delivered: number
}

export interface EmailReportTickResult {
  acquired: boolean
  enqueue?: EnqueueResult
  deliver?: DeliverResult
}

/**
 * Creates the delivery rows of every due report whose data is ready, and moves the schedules on.
 * One transaction, the reports selected FOR UPDATE SKIP LOCKED: nothing else can enqueue the same
 * period, and a crash before COMMIT leaves both the row and the schedule as they were.
 */
export async function enqueueDueReports(
  deps: EmailReportDeps,
  lease?: LeaderLease,
): Promise<EnqueueResult> {
  const now = (deps.now ?? (() => new Date()))()
  await lease?.assertHeld()

  return deps.db.withTransaction(async (tx) => {
    const due = await repo.loadDueReports(tx, now, MAX_REPORTS_PER_TICK)
    const result: EnqueueResult = { enqueued: 0, due: due.length, waiting: 0, empty: 0 }

    for (const report of due) {
      const log = deps.log.child({ emailReportId: report.id, emailReport: report.name })
      // Read before any statement for this report runs, so a failure leaves the transaction usable.
      let next: Date
      let prepared: PreparedReport
      try {
        next = nextRunAfter(report.scheduleCron, report.timezone, now)
        prepared = kindOf(report.kind).prepare(report.settings)
      } catch (error) {
        log.error({ err: error }, 'email report cannot be read; postponing')
        await repo.updateNextRun(tx, report.id, new Date(now.getTime() + BAD_CONFIG_RETRY_MS))
        continue
      }

      const period = reportPeriod(report.frequency, report.timezone, now)
      const incomplete = await prepared.incomplete(tx, report, period)
      if (incomplete.length > 0) {
        if (now < waitDeadline(report.nextRunAt, report.timezone)) {
          result.waiting += 1
          log.debug({ period, incomplete }, 'email report waiting for its data')
          continue
        }
        log.warn(
          { period, incomplete },
          'email report data still incomplete at the deadline; sending what there is',
        )
      }

      const id = randomUUID()
      const built = await prepared.build(tx, report, period, id, now, log)
      if (built.rowCount === 0) {
        await repo.updateNextRun(tx, report.id, next)
        result.empty += 1
        log.info({ period, nextRunAt: next }, 'email report period has no rows; nothing sent')
        continue
      }

      const inserted = await repo.insertDelivery(tx, {
        id,
        reportId: report.id,
        period,
        trigger: 'schedule',
        document: built.document,
        contentType: built.contentType,
      })
      await repo.updateNextRun(tx, report.id, next)

      if (inserted === undefined) {
        log.info({ period }, 'email report period already enqueued')
      } else {
        result.enqueued += 1
        log.info(
          { period, deliveryId: id, rows: built.rowCount, nextRunAt: next },
          'email report delivery enqueued',
        )
      }
    }
    return result
  })
}

/** One attempt for each pending delivery that is due, oldest first, each claimed just before. */
export async function deliverDueEmails(deps: EmailReportDeps): Promise<DeliverResult> {
  const clock = deps.now ?? (() => new Date())
  const result: DeliverResult = { attempted: 0, delivered: 0 }

  while (result.attempted < MAX_DELIVERIES_PER_TICK) {
    // Shutdown stops the queue where it is; the rows stay pending and the next tick resumes.
    if (deps.signal?.aborted) break
    const now = clock()
    const delivery = await repo.claimNextDelivery(deps.db, now, leaseUntil(now))
    if (!delivery) break
    const outcome = await deliverOnce(deps, delivery)
    result.attempted += 1
    if (outcome.delivered) result.delivered += 1
  }
  return result
}

/** One full tick, behind the leader lock. `acquired: false` when another replica has it. */
export async function runEmailReportTick(deps: EmailReportDeps): Promise<EmailReportTickResult> {
  const limited: EmailReportDeps = {
    ...deps,
    db: limitDb(deps.db, createLimiter(EMAIL_REPORT_MAX_CONNECTIONS)),
  }
  const locked = await deps.db.withAdvisoryLock(EMAIL_REPORT_LEADER_LOCK_KEY, async (lease) => {
    const enqueue = await enqueueDueReports(limited, lease)
    const deliver = await deliverDueEmails(limited)
    return { enqueue, deliver }
  })

  if (!locked.acquired) {
    deps.log.debug('email report tick skipped: another process holds the leader lock')
    return { acquired: false }
  }
  return { acquired: true, ...locked.result }
}

export interface EmailReportScheduler {
  /** Stops future ticks and waits for a tick that is already running. */
  stop(): Promise<void>
}

type Schedule = (
  expression: string,
  task: () => Promise<void>,
  options: TaskOptions,
) => { stop(): void | Promise<void> }

export interface EmailReportSchedulerOptions {
  /** Injectable for tests; defaults to node-cron's schedule. */
  schedule?: Schedule
}

export function startEmailReportScheduler(
  deps: EmailReportDeps,
  options: EmailReportSchedulerOptions = {},
): EmailReportScheduler {
  const schedule: Schedule = options.schedule ?? cronSchedule
  const log = deps.log.child({ component: 'email-report-scheduler' })
  let running: Promise<void> | undefined

  async function tick(): Promise<void> {
    try {
      await runEmailReportTick({ ...deps, log })
    } catch (error) {
      // A failed tick is logged and forgotten; the next minute starts clean.
      log.error({ err: error }, 'email report tick failed')
    }
  }

  const task = schedule(
    EMAIL_REPORT_TICK_CRON,
    () => {
      running ??= tick().finally(() => {
        running = undefined
      })
      return running
    },
    {
      name: 'email-report-tick',
      // Timezone-free: every report carries its own.
      timezone: 'UTC',
      noOverlap: true,
      logger: cronLogger(log),
    },
  )
  log.info(
    { cron: EMAIL_REPORT_TICK_CRON, provider: deps.mailer.provider },
    'email report scheduler started',
  )

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
