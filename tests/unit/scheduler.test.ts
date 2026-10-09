import type { TaskOptions } from 'node-cron'
import { describe, expect, it } from 'vitest'
import type { Db } from '../../src/core/db.ts'
import { createLimiter } from '../../src/core/limiter.ts'
import { createLogger } from '../../src/core/log.ts'
import type { SyncDeps } from '../../src/modules/sync/engine.ts'
import { NIGHTLY_LEADER_LOCK_KEY } from '../../src/modules/sync/nightly.ts'
import { createRegistry } from '../../src/modules/sync/registry.ts'
import { NIGHTLY_CRON, startNightlyScheduler } from '../../src/modules/sync/scheduler.ts'

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
  it('schedules 04:00 in Zurich without overlapping ticks', () => {
    const cron = fakeCron()
    startNightlyScheduler(
      deps(() => Promise.resolve({ acquired: false })),
      { schedule: cron.schedule },
    )
    expect(cron.calls.map((c) => c.expression)).toEqual([NIGHTLY_CRON])
    expect(NIGHTLY_CRON).toBe('0 4 * * *')
    expect(cron.calls[0]?.options).toMatchObject({
      name: 'nightly-sync',
      timezone: 'Europe/Zurich',
      noOverlap: true,
    })
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
