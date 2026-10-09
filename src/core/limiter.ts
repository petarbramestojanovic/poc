// A counting semaphore. The sync module runs its database work through one of these so batch
// work can never hold more than its share of the pool (RFC-002 §14.1: 3 of 10) and starve
// /readyz and the request path.

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>
  readonly active: number
  readonly pending: number
}

export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('limiter max must be an integer >= 1')
  let active = 0
  const waiting: (() => void)[] = []

  function release(): void {
    const next = waiting.shift()
    if (next) next()
    else active--
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < max) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await fn()
    } finally {
      release()
    }
  }

  return {
    run,
    get active() {
      return active
    },
    get pending() {
      return waiting.length
    },
  }
}
