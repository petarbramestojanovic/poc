import { schedule as cronSchedule, type TaskOptions } from 'node-cron'
import type { Logger } from '../log.ts'
import type { SyncDeps } from './engine.ts'
import { NIGHTLY_TIMEZONE, runNightlyTick } from './nightly.ts'

// The 04:00 Europe/Zurich trigger for the nightly pass (RFC-003 §5). Every replica schedules it;
// the leader lock inside runNightlyTick lets exactly one of them run the pass. A tick never
// throws: a failed pass is logged, and the next night starts fresh.

export const NIGHTLY_CRON = '0 4 * * *'

export interface NightlyScheduler {
  /** Stops future ticks and waits for a tick that is already running. */
  stop(): Promise<void>
}

type Schedule = (
  expression: string,
  task: () => Promise<void>,
  options: TaskOptions,
) => { stop(): void | Promise<void> }

export interface SchedulerOptions {
  /** Injectable for tests; defaults to node-cron's schedule. */
  schedule?: Schedule
}

export function startNightlyScheduler(
  deps: SyncDeps,
  options: SchedulerOptions = {},
): NightlyScheduler {
  const schedule: Schedule = options.schedule ?? cronSchedule
  const log = deps.log.child({ component: 'nightly-scheduler' })
  let running: Promise<void> | undefined

  async function tick(): Promise<void> {
    try {
      await runNightlyTick({ ...deps, log })
    } catch (error) {
      // A crashed pass must never take the process down with it.
      log.error({ err: error }, 'nightly pass failed')
    }
  }

  const task = schedule(
    NIGHTLY_CRON,
    () => {
      running ??= tick().finally(() => {
        running = undefined
      })
      return running
    },
    {
      name: 'nightly-sync',
      timezone: NIGHTLY_TIMEZONE,
      noOverlap: true,
      logger: cronLogger(log),
    },
  )
  log.info({ cron: NIGHTLY_CRON, timezone: NIGHTLY_TIMEZONE }, 'nightly sync scheduled')

  return {
    async stop() {
      await task.stop()
      await running
    },
  }
}

/** node-cron's own messages (missed executions, overlaps) go through pino, not the console. */
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
