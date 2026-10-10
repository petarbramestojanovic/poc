import { describe, expect, it } from 'vitest'
import type { WebhookDeps } from '../../src/modules/webhooks/scheduler.ts'
import {
  deliverDueDeliveries,
  enqueueDueWebhooks,
  nextRunAfter,
  runWebhookTick,
  startWebhookScheduler,
  waitDeadline,
  WEBHOOK_TICK_CRON,
} from '../../src/modules/webhooks/scheduler.ts'
import { at } from '../helpers.ts'
import { fakeDb, fakeHttp, response, silentLogger } from './webhook-fakes.ts'

const NOW = new Date('2026-09-14T03:00:00Z') // Monday 05:00 in Zurich
const NOON = new Date('2026-09-14T10:00:00Z') // Monday 12:00 in Zurich

const COLUMNS = {
  source: 'zeus',
  columns: [
    { name: 'Impressions', formula: 'impressions', decimals: 0 },
    { name: 'Cost', formula: 'impressions / 1000 * price', decimals: 2 },
  ],
}

const webhookRow = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000009b0',
  name: 'weekly',
  company_id: '00000000-0000-4000-8000-000000000001',
  campaign_ids: null,
  url: 'https://client.example.com/hook',
  secret: 'whsec_test',
  schedule_cron: '0 5 * * 1',
  timezone: 'Europe/Zurich',
  report_window: 'previous_week',
  format: 'json',
  enabled: true,
  next_run_at: NOW,
  payload_fields: COLUMNS,
  ...over,
})

const metricsRow = {
  campaign_id: '00000000-0000-4000-8000-000000000002',
  campaign: 'DE2609 Tchibo Caffè Crema',
  price: '15.5876',
  events_date: '2026-09-08',
  language: 'de',
  campaign_tag: '',
  impressions: '1001',
}

interface Answers {
  due?: unknown[]
  incomplete?: string[]
  metrics?: unknown[]
}

/** The tick's statements, answered by what they read; the delivery insert lands. */
const answering =
  ({ due = [webhookRow()], incomplete = [], metrics = [metricsRow] }: Answers) =>
  (text: string, params: unknown[]): unknown[] => {
    if (text.includes('WHERE enabled AND next_run_at')) return due
    if (text.includes('external.sync_state')) return incomplete.map((name) => ({ name }))
    if (text.includes('FROM analytics.advanced_analytics')) return metrics
    if (text.includes('INSERT INTO app.webhook_delivery')) return [{ id: params[0] }]
    return []
  }

const inZurich = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)

function deps(
  respond: (text: string, params: unknown[]) => unknown[],
  now: Date = NOW,
): {
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
      now: () => now,
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

describe('waitDeadline', () => {
  it('is noon in the webhook timezone, on the day the report was due', () => {
    expect(waitDeadline(NOW, 'Europe/Zurich').toISOString()).toBe('2026-09-14T10:00:00.000Z')
    expect(waitDeadline(NOW, 'UTC').toISOString()).toBe('2026-09-14T12:00:00.000Z')
  })

  it('stays at noon local on the days the clocks change', () => {
    // 2026-03-29 jumps to CEST at 02:00, 2026-10-25 falls back to CET at 03:00.
    expect(waitDeadline(new Date('2026-03-29T03:00:00Z'), 'Europe/Zurich').toISOString()).toBe(
      '2026-03-29T10:00:00.000Z',
    )
    expect(waitDeadline(new Date('2026-10-25T04:00:00Z'), 'Europe/Zurich').toISOString()).toBe(
      '2026-10-25T11:00:00.000Z',
    )
  })
})

describe('enqueueDueWebhooks', () => {
  it('stores the rendered report with its own id inside, and moves the schedule on', async () => {
    const { deps: d, db } = deps(answering({}))

    const result = await enqueueDueWebhooks(d)

    expect(result).toEqual({ enqueued: 1, due: 1, waiting: 0, empty: 0 })
    // The period is the week that closed yesterday, in the webhook's timezone.
    expect(at(db.matching('FROM analytics.advanced_analytics')).params.slice(2)).toEqual([
      'zeus',
      '2026-09-07',
      '2026-09-13',
    ])
    const [id, webhookId, from, to, trigger, document] = at(
      db.matching('INSERT INTO app.webhook_delivery'),
    ).params
    expect([webhookId, from, to, trigger]).toEqual([
      webhookRow().id,
      '2026-09-07',
      '2026-09-13',
      'schedule',
    ])
    // The document is text, rendered once, carrying the id the row is inserted under.
    expect(JSON.parse(document as string)).toMatchObject({
      version: 2,
      delivery_id: id,
      period: { start: '2026-09-07', end: '2026-09-13', frequency: 'weekly' },
      rows: [
        {
          Date: '2026-09-08',
          Campaign: 'DE2609 Tchibo Caffè Crema',
          Impressions: 1001,
          Cost: 15.6,
        },
      ],
    })
    const [, nextRunAt] = at(db.matching('SET next_run_at = $2')).params
    expect((nextRunAt as Date).toISOString()).toBe('2026-09-21T03:00:00.000Z')
  })

  it("stores a csv webhook's report as the CSV file", async () => {
    const { deps: d, db } = deps(answering({ due: [webhookRow({ format: 'csv' })] }))

    await enqueueDueWebhooks(d)

    expect(at(db.matching('INSERT INTO app.webhook_delivery')).params[5]).toBe(
      'Date,Campaign,Impressions,Cost\r\n2026-09-08,DE2609 Tchibo Caffè Crema,1001,15.6\r\n',
    )
  })

  it("waits, leaving the webhook due, while a campaign's data is incomplete before noon", async () => {
    const { deps: d, db } = deps(answering({ incomplete: ['DE2609 Tchibo Caffè Crema'] }))

    const result = await enqueueDueWebhooks(d)

    expect(result).toEqual({ enqueued: 0, due: 1, waiting: 1, empty: 0 })
    expect(db.matching('FROM analytics.advanced_analytics')).toEqual([])
    expect(db.matching('INSERT INTO app.webhook_delivery')).toEqual([])
    // Not moved on: the next tick looks again.
    expect(db.matching('SET next_run_at = $2')).toEqual([])
  })

  it('sends what there is once noon has come', async () => {
    const { deps: d, db } = deps(answering({ incomplete: ['DE2609 Tchibo Caffè Crema'] }), NOON)

    const result = await enqueueDueWebhooks(d)

    expect(result).toMatchObject({ enqueued: 1, waiting: 0 })
    expect(db.matching('INSERT INTO app.webhook_delivery')).toHaveLength(1)
  })

  it('does not wait for a report due in the afternoon', async () => {
    const afternoon = new Date('2026-09-14T13:00:00Z')
    const { deps: d } = deps(
      answering({
        due: [webhookRow({ schedule_cron: '0 15 * * 1', next_run_at: afternoon })],
        incomplete: ['DE2609 Tchibo Caffè Crema'],
      }),
      afternoon,
    )

    expect(await enqueueDueWebhooks(d)).toMatchObject({ enqueued: 1, waiting: 0 })
  })

  it('sends nothing for a period without rows, and still moves the schedule on', async () => {
    const { deps: d, db } = deps(answering({ metrics: [] }))

    const result = await enqueueDueWebhooks(d)

    expect(result).toEqual({ enqueued: 0, due: 1, waiting: 0, empty: 1 })
    expect(db.matching('INSERT INTO app.webhook_delivery')).toEqual([])
    const [, nextRunAt] = at(db.matching('SET next_run_at = $2')).params
    expect((nextRunAt as Date).toISOString()).toBe('2026-09-21T03:00:00.000Z')
  })

  it('postpones a webhook whose stored column list cannot be read, and enqueues the others', async () => {
    // A version 1 field list, as rows created before 0008 hold.
    const broken = webhookRow({ id: 'broken', payload_fields: { calculated: [] } })
    const { deps: d, db } = deps(answering({ due: [broken, webhookRow()] }))

    const result = await enqueueDueWebhooks(d)

    expect(result).toMatchObject({ enqueued: 1, due: 2 })
    // Nothing was read or stored for the broken one: it is pushed an hour out instead.
    expect(db.matching('INSERT INTO app.webhook_delivery').map((q) => q.params[1])).toEqual([
      webhookRow().id,
    ])
    const moves = db.matching('SET next_run_at = $2').map((q) => q.params)
    const brokenMove = moves.find(([id]) => id === 'broken')
    expect((brokenMove?.[1] as Date).getTime()).toBe(NOW.getTime() + 3_600_000)
  })

  it('does not count a period that already has a row', async () => {
    const { deps: d, db } = deps((text, params) =>
      text.includes('INSERT INTO app.webhook_delivery') ? [] : answering({})(text, params),
    )

    const result = await enqueueDueWebhooks(d)

    expect(result).toMatchObject({ enqueued: 0, due: 1 })
    // The schedule still moves on, or the webhook would be due again in a minute.
    expect(db.matching('SET next_run_at = $2')).toHaveLength(1)
  })

  it('postpones a webhook whose cron cannot be parsed instead of enqueueing it', async () => {
    const { deps: d, db } = deps(
      answering({ due: [webhookRow({ schedule_cron: 'every other tuesday' })] }),
    )

    const result = await enqueueDueWebhooks(d)

    expect(result).toMatchObject({ enqueued: 0, due: 1 })
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
    payload: '{"version":2}',
    url: 'https://client.example.com/hook',
    secret: 'whsec_test',
    format: 'json',
    auth_header: null,
    auth_token: null,
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
    const { deps: d } = deps(answering({}))

    expect(await runWebhookTick(d)).toEqual({
      acquired: true,
      enqueue: { enqueued: 1, due: 1, waiting: 0, empty: 0 },
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
