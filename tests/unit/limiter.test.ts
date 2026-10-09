import { describe, expect, it } from 'vitest'
import { limitDb, type Db } from '../../src/core/db.ts'
import { createLimiter } from '../../src/core/limiter.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('limiter', () => {
  it('never runs more than max tasks at once and runs all of them', async () => {
    const limiter = createLimiter(2)
    let running = 0
    let peak = 0
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limiter.run(async () => {
          running++
          peak = Math.max(peak, running)
          await tick()
          running--
          return n
        }),
      ),
    )
    expect(results).toEqual([1, 2, 3, 4, 5])
    expect(peak).toBe(2)
    expect(limiter.active).toBe(0)
    expect(limiter.pending).toBe(0)
  })

  it('releases the slot when a task fails', async () => {
    const limiter = createLimiter(1)
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(limiter.run(() => Promise.resolve('next'))).resolves.toBe('next')
    expect(limiter.active).toBe(0)
  })

  it('rejects a non-positive max', () => {
    expect(() => createLimiter(0)).toThrow(RangeError)
  })

  it('limitDb caps concurrent queries and transactions but not the leader lock', async () => {
    let active = 0
    let peak = 0
    const busy = async <T>(value: T): Promise<T> => {
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
      return value
    }
    const inner: Db = {
      query: () => busy([]),
      withTransaction: (fn) =>
        busy(null).then(() =>
          fn({ query: () => Promise.resolve([]), xactLock: () => Promise.resolve() }),
        ),
      withAdvisoryLock: (_key, fn) =>
        fn({ assertHeld: () => Promise.resolve() }).then((result) => ({ acquired: true, result })),
      stats: () => ({ total: 0, idle: 0, waiting: 0 }),
      close: () => Promise.resolve(),
    }
    const limited = limitDb(inner, createLimiter(3))
    await Promise.all([
      ...Array.from({ length: 6 }, () => limited.query('SELECT 1')),
      ...Array.from({ length: 4 }, () => limited.withTransaction(() => Promise.resolve(1))),
    ])
    expect(peak).toBe(3)

    // The leader lock body runs limited work inside it without deadlocking a max-1 limiter.
    const single = limitDb(inner, createLimiter(1))
    const held = await single.withAdvisoryLock(1, () => single.query('SELECT 1'))
    expect(held.acquired).toBe(true)
  })
})
