import { describe, expect, it } from 'vitest'
import type { WebhookDeps } from '../../src/webhooks/scheduler.ts'
import {
  deliverDueDeliveries,
  enqueueDueWebhooks,
  nextRunAfter,
  runWebhookTick,
  startWebhookScheduler,
  WEBHOOK_TICK_CRON,
} from '../../src/webhooks/scheduler.ts'
import { at } from '../helpers.ts'
import { fakeDb, fakeHttp, response, silentLogger } from './webhook-fakes.ts'

const NOW = new Date('2026-09-14T06:00:00Z') // Monday 08:00 in Zurich

const webhookRow = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000009b0',
  name: 'weekly',
  url: 'https://client.example.com/hook',
  secret: 'whsec_test',
  schedule_cron: '0 8 * * 1',
  timezone: 'Europe/Zurich',
  report_window: 'previous_week',
  enabled: true,
  next_run_at: NOW,
  ...over,
})

const inZurich = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)

function deps(respond: (text: string, params: unknown[]) => unknown[]): {
  deps: WebhookDeps
  db: ReturnType<typeof fakeDb>
} {
  const db = fakeDb(respond)
  return {
    db,
    deps: {
      db: db.db,
      http: fakeHttp(() => response(200)).http,
      log: silentLogger(),
      now: () => NOW,
      lookup: () => Promise.resolve([{ address: '93.184.216.34' }]),
    },
  }
}

describe('nextRunAfter', () => {
  it('keeps 08:00 local across the spring clock change', () => {
    // The Sunday between: Europe/Zurich jumps to CEST on 2026-03-29.
    const next = nextRunAfter('0 8 * * 1', 'Europe/Zurich', new Date('2026-03-23T08:00:00Z'))
    expect(next.toISOString()).toBe('2026-03-30T06:00:00.000Z')
    expect(inZurich(next)).toBe('30/03/2026, 08:00')
  })

  it('keeps 08:00 local across the autumn clock change', () => {
    // Europe/Zurich returns to CET on 2026-10-25.
    const next = nextRunAfter('0 8 * * 1', 'Europe/Zurich', new Date('2026-10-19T07:00:00Z'))
    expect(next.toISOString()).toBe('2026-10-26T07:00:00.000Z')
    expect(inZurich(next)).toBe('26/10/2026, 08:00')
  })

  it('rejects an expression it cannot read', () => {
    expect(() => nextRunAfter('not a cron', 'Europe/Zurich', NOW)).toThrow()
  })
})

describe('enqueueDueWebhooks', () => {
  it('creates the delivery and moves the schedule on, in one transaction', async () => {
    const { deps: d, db } = deps((text) => {
      if (text.includes('WHERE enabled AND next_run_at')) return [webhookRow()]
      if (text.includes('INSERT INTO app.webhook_delivery')) return [{ id: 'delivery-1' }]
      return []
    })

    const result = await enqueueDueWebhooks(d)

    expect(result).toEqual({ enqueued: 1, due: 1 })
    // The period is the week that closed yesterday, in the webhook's timezone.
    expect(at(db.matching('INSERT INTO app.webhook_delivery')).params.slice(0, 4)).toEqual([
      webhookRow().id,
      '2026-09-07',
      '2026-09-13',
      'schedule',
    ])
    const [, nextRunAt] = at(db.matching('SET next_run_at = $2')).params
    expect((nextRunAt as Date).toISOString()).toBe('2026-09-21T06:00:00.000Z')
  })

  it('does not count a period that already has a row', async () => {
    const { deps: d, db } = deps((text) =>
      text.includes('WHERE enabled AND next_run_at') ? [webhookRow()] : [],
    )

    const result = await enqueueDueWebhooks(d)

    expect(result).toEqual({ enqueued: 0, due: 1 })
    // The schedule still moves on, or the webhook would be due again in a minute.
    expect(db.matching('SET next_run_at = $2')).toHaveLength(1)
  })

  it('postpones a webhook whose cron cannot be parsed instead of enqueueing it', async () => {
    const { deps: d, db } = deps((text) =>
      text.includes('WHERE enabled AND next_run_at')
        ? [webhookRow({ schedule_cron: 'every other tuesday' })]
        : [],
    )

    const result = await enqueueDueWebhooks(d)

    expect(result).toEqual({ enqueued: 0, due: 1 })
    expect(db.matching('INSERT INTO app.webhook_delivery')).toEqual([])
    const [, nextRunAt] = at(db.matching('SET next_run_at = $2')).params
    expect((nextRunAt as Date).getTime()).toBe(NOW.getTime() + 3_600_000)
  })

  it('checks the lease before it writes anything', async () => {
    const { deps: d, db } = deps(() => [])
    let held = 0

    await enqueueDueWebhooks(d, {
      assertHeld: () => {
        held += 1
        return Promise.resolve()
      },
    })

    expect(held).toBe(1)
    expect(db.queries.length).toBeGreaterThan(0)
  })
})

describe('deliverDueDeliveries', () => {
  const dueRow = (id: string) => ({
    id,
    webhook_id: webhookRow().id,
    period_start: '2026-09-07',
    period_end: '2026-09-13',
    attempts: 1, // counted by the claim
    payload: { version: 1 },
    url: 'https://client.example.com/hook',
    secret: 'whsec_test',
  })

  /** Answers each claim with the next due row, then with nothing, like the real queue. */
  const queue = (...ids: string[]) => {
    const due = ids.map(dueRow)
    return (text: string) => {
      if (text.includes('SKIP LOCKED')) return due.splice(0, 1)
      if (text.includes('UPDATE app.webhook_delivery')) return [{ id: 'recorded' }]
      return []
    }
  }

  it('claims and attempts every due delivery, one at a time', async () => {
    const { deps: d, db } = deps(queue('a', 'b'))

    expect(await deliverDueDeliveries(d)).toEqual({ attempted: 2, delivered: 2 })
    // Two claims that each returned a row, and a third that found the queue empty.
    expect(db.matching('SKIP LOCKED')).toHaveLength(3)
  })

  it('stops where it is when the process is shutting down', async () => {
    const { deps: d } = deps(queue('a', 'b'))
    const controller = new AbortController()
    controller.abort()

    expect(await deliverDueDeliveries({ ...d, signal: controller.signal })).toEqual({
      attempted: 0,
      delivered: 0,
    })
  })
})

describe('runWebhookTick', () => {
  it('reports the work it did when it holds the lock', async () => {
    const { deps: d } = deps((text) => {
      if (text.includes('WHERE enabled AND next_run_at')) return [webhookRow()]
      if (text.includes('INSERT INTO app.webhook_delivery')) return [{ id: 'delivery-1' }]
      return []
    })

    expect(await runWebhookTick(d)).toEqual({
      acquired: true,
      enqueue: { enqueued: 1, due: 1 },
      deliver: { attempted: 0, delivered: 0 },
    })
  })

  it('does nothing when another replica holds the lock', async () => {
    const { deps: d, db } = deps(() => [])
    const notLeader = {
      ...d,
      db: { ...db.db, withAdvisoryLock: () => Promise.resolve({ acquired: false }) },
    }

    expect(await runWebhookTick(notLeader)).toEqual({ acquired: false })
    expect(db.queries).toEqual([])
  })
})

describe('startWebhookScheduler', () => {
  it('schedules a minutely tick and waits for a running one when stopped', async () => {
    const { deps: d } = deps(() => [])
    let expression = ''
    let task: (() => Promise<void>) | undefined
    let stopped = false

    const scheduler = startWebhookScheduler(d, {
      schedule: (cron, fn) => {
        expression = cron
        task = fn
        return {
          stop: () => {
            stopped = true
          },
        }
      },
    })

    expect(expression).toBe(WEBHOOK_TICK_CRON)
    await task?.()
    await scheduler.stop()
    expect(stopped).toBe(true)
  })

  it('never lets a failing tick escape', async () => {
    const { deps: d } = deps(() => {
      throw new Error('database gone')
    })
    let task: (() => Promise<void>) | undefined
    const scheduler = startWebhookScheduler(d, {
      schedule: (_cron, fn) => {
        task = fn
        return { stop: () => undefined }
      },
    })

    await expect(task?.()).resolves.toBeUndefined()
    await scheduler.stop()
  })
})
