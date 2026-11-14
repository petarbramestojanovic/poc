import type { TaskOptions } from 'node-cron'
import { describe, expect, it } from 'vitest'
import type { Db } from '../../src/core/db.ts'
import { createLimiter } from '../../src/core/limiter.ts'
import { createLogger } from '../../src/core/log.ts'
import type { SyncDeps } from '../../src/modules/sync/engine.ts'
import { todayIn, yesterdayIn } from '../../src/core/dates.ts'
import { NIGHTLY_LEADER_LOCK_KEY, NIGHTLY_TIMEZONE } from '../../src/modules/sync/nightly.ts'
import { createRegistry } from '../../src/modules/sync/registry.ts'
import {
  NIGHTLY_CRON,
  NIGHTLY_CRON_TIMEZONE,
  startNightlyScheduler,
} from '../../src/modules/sync/scheduler.ts'

function deps(withAdvisoryLock: Db['withAdvisoryLock']): SyncDeps {
  const db: Db = {
    query: () => Promise.resolve([]),
    withTransaction: () => Promise.reject(new Error('unused')),
    withAdvisoryLock,
    stats: () => ({ total: 0, idle: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  }
  return {
    db,
    registry: createRegistry([]),
    http: { request: () => Promise.reject(new Error('unused')) },
    log: createLogger('silent'),
    limiter: createLimiter(3),
  }
}

/** Stands in for node-cron: records the schedule and lets the test fire the tick by hand. */
function fakeCron() {
  const calls: { expression: string; options: TaskOptions }[] = []
  let task: (() => Promise<void>) | undefined
  let stopped = false
  return {
    calls,
    isStopped: () => stopped,
    fire: (): Promise<void> => {
      if (!task) throw new Error('nothing scheduled')
      return task()
    },
    schedule: (expression: string, fn: () => Promise<void>, options: TaskOptions) => {
      calls.push({ expression, options })
      task = fn
      return {
        stop: () => {
          stopped = true
        },
      }
    },
  }
}

describe('nightly scheduler', () => {
  it('schedules 00:30 UTC without overlapping ticks', () => {
    const cron = fakeCron()
    startNightlyScheduler(
      deps(() => Promise.resolve({ acquired: false })),
      { schedule: cron.schedule },
    )
    expect(cron.calls.map((c) => c.expression)).toEqual([NIGHTLY_CRON])
    expect(NIGHTLY_CRON).toBe('30 0 * * *')
    expect(cron.calls[0]?.options).toMatchObject({
      name: 'nightly-sync',
      timezone: NIGHTLY_CRON_TIMEZONE,
      noOverlap: true,
    })
  })

  // Every night of a year with both clock changes: the pass starts after the sources' (UTC) day
  // is over, so it syncs through yesterday — the very day a daily Zurich webhook reports on — and
  // before 03:00 in Zurich (Tchibo's send). At 01:59 Zurich, summer nights would stop a day short.
  it('runs every night after the UTC day ends and before 03:00 in Zurich', () => {
    expect(NIGHTLY_CRON_TIMEZONE).toBe('UTC')
    const [minute, hour] = NIGHTLY_CRON.split(' ').map(Number)
    const zurichHour = new Intl.DateTimeFormat('en-GB', {
      timeZone: NIGHTLY_TIMEZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    })
    let nights = 0
    for (let day = Date.UTC(2027, 0, 1); day < Date.UTC(2028, 0, 1); day += 86_400_000) {
      const run = new Date(day + ((hour ?? NaN) * 60 + (minute ?? NaN)) * 60_000)
      expect(yesterdayIn('UTC', run)).toBe(yesterdayIn(NIGHTLY_TIMEZONE, run))
      expect(todayIn('UTC', run)).toBe(todayIn(NIGHTLY_TIMEZONE, run)) // the deep pull's Sunday
      expect(Number(zurichHour.format(run))).toBeLessThan(3)
      nights++
    }
    expect(nights).toBe(365)
  })

  it('runs every tick behind the nightly leader lock', async () => {
    const keys: number[] = []
    const cron = fakeCron()
    startNightlyScheduler(
      deps(async (key) => {
        keys.push(key)
        return { acquired: false }
      }),
      { schedule: cron.schedule },
    )
    await cron.fire()
    await cron.fire()
    expect(keys).toEqual([NIGHTLY_LEADER_LOCK_KEY, NIGHTLY_LEADER_LOCK_KEY])
  })

  it('never throws from a tick, so one bad night cannot take the process down', async () => {
    const cron = fakeCron()
    startNightlyScheduler(
      deps(() => Promise.reject(new Error('database down'))),
      { schedule: cron.schedule },
    )
    await expect(cron.fire()).resolves.toBeUndefined()
  })

  it('stop() ends future ticks and waits for the running one', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cron = fakeCron()
    const scheduler = startNightlyScheduler(
      deps(async () => {
        await gate
        return { acquired: false }
      }),
      { schedule: cron.schedule },
    )

    const tick = cron.fire()
    let stopped = false
    const stopping = scheduler.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(cron.isStopped()).toBe(true)
    expect(stopped).toBe(false)

    release()
    await Promise.all([tick, stopping])
    expect(stopped).toBe(true)
  })
})
