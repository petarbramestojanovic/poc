import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import type { Db } from '../../src/core/db.ts'
import { createLogger } from '../../src/core/log.ts'
import type { SendDeps } from '../../src/modules/webhooks/send.ts'
import { at } from '../helpers.ts'
import { fakeDb, fakeHttp, response } from './webhook-fakes.ts'

const TOKEN = 'a-long-enough-operator-token-0123456789'
const WEBHOOK = '00000000-0000-4000-8000-0000000009b0'
const auth = { authorization: `Bearer ${TOKEN}` }

const config: Config = {
  databaseUrl: 'postgresql://x',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: TOKEN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
}

/** Refused before the handler runs: the database must never be reached. */
const untouchable: Db = {
  query: () => Promise.reject(new Error('database reached')),
  withTransaction: () => Promise.reject(new Error('database reached')),
  withAdvisoryLock: () => Promise.reject(new Error('database reached')),
  stats: () => ({ total: 0, idle: 0, waiting: 0 }),
  close: () => Promise.resolve(),
}

const apps: FastifyInstance[] = []

function build(db: Db = untouchable): FastifyInstance {
  const webhooks: SendDeps = {
    db,
    http: fakeHttp(() => response(200)).http,
    log: createLogger('silent'),
    lookup: () => Promise.resolve([{ address: '93.184.216.34' }]),
  }
  const app = buildApp({ config, db, logger: createLogger('silent'), webhooks })
  apps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const webhookRow = (over: Record<string, unknown> = {}) => ({
  id: WEBHOOK,
  name: 'weekly',
  url: 'https://client.example.com/hook',
  secret: 'whsec_test',
  schedule_cron: '0 8 * * 1',
  timezone: 'Europe/Zurich',
  report_window: 'previous_week',
  enabled: true,
  next_run_at: new Date('2026-09-21T06:00:00Z'),
  ...over,
})

describe('POST /webhooks/:id/send-now, refused before the handler', () => {
  it('needs the operator token', async () => {
    const res = await build().inject({ method: 'POST', url: `/webhooks/${WEBHOOK}/send-now` })
    expect(res.statusCode).toBe(401)
  })

  it('answers 401, not 404, for an unknown path under the prefix', async () => {
    const res = await build().inject({ method: 'GET', url: '/webhooks/nope' })
    expect(res.statusCode).toBe(401)
  })

  it.each([
    { name: 'a malformed webhook id', url: '/webhooks/not-a-uuid/send-now', payload: {} },
    {
      name: 'a period start without an end',
      url: `/webhooks/${WEBHOOK}/send-now`,
      payload: { period_start: '2026-09-07' },
    },
    {
      name: 'an impossible date',
      url: `/webhooks/${WEBHOOK}/send-now`,
      payload: { period_start: '2026-02-31', period_end: '2026-03-01' },
    },
    {
      name: 'an end before the start',
      url: `/webhooks/${WEBHOOK}/send-now`,
      payload: { period_start: '2026-09-13', period_end: '2026-09-07' },
    },
    {
      name: 'a period longer than a year',
      url: `/webhooks/${WEBHOOK}/send-now`,
      payload: { period_start: '2025-01-01', period_end: '2026-09-07' },
    },
    {
      name: 'an unknown field',
      url: `/webhooks/${WEBHOOK}/send-now`,
      payload: { periodStart: '2026-09-07' },
    },
  ])('answers 400 for $name', async ({ url, payload }) => {
    const res = await build().inject({ method: 'POST', url, payload, headers: auth })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /webhooks/:id/send-now', () => {
  it('answers 202 with the delivery id', async () => {
    const db = fakeDb((text) => {
      if (text.includes('FROM app.webhook\n WHERE id')) return [webhookRow()]
      if (text.includes('INSERT INTO app.webhook_delivery')) return [{ id: WEBHOOK }]
      return []
    })

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      payload: { period_start: '2026-09-07', period_end: '2026-09-13' },
      headers: auth,
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({
      deliveryId: WEBHOOK,
      periodStart: '2026-09-07',
      periodEnd: '2026-09-13',
    })
  })

  it('answers 404 for a webhook that does not exist', async () => {
    const db = fakeDb(() => [])
    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      headers: auth,
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'webhook_not_found' })
  })

  it('answers 409 for a disabled webhook', async () => {
    const db = fakeDb((text) =>
      text.includes('FROM app.webhook\n WHERE id') ? [webhookRow({ enabled: false })] : [],
    )
    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      headers: auth,
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'webhook_disabled' })
  })

  it('answers 409 rather than re-sending a period that already went out', async () => {
    const db = fakeDb((text) => {
      if (text.includes('FROM app.webhook\n WHERE id')) return [webhookRow()]
      if (text.includes('FROM app.webhook_delivery\n WHERE webhook_id')) {
        return [{ id: 'delivery-1', status: 'delivered', attempts: 1 }]
      }
      return []
    })

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      headers: auth,
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'already_delivered' })
    expect(db.matching('UPDATE app.webhook_delivery')).toEqual([])
  })
})

describe('PATCH /webhooks/:id and POST /webhooks/:id/preview, refused before the handler', () => {
  it.each([
    ['PATCH', `/webhooks/${WEBHOOK}`],
    ['POST', `/webhooks/${WEBHOOK}/preview`],
  ] as const)('%s %s needs the operator token', async (method, url) => {
    const res = await build().inject({ method, url, payload: { fields: null } })
    expect(res.statusCode).toBe(401)
  })

  it.each([
    ['no fields key at all', {}],
    ['a metric the catalog does not have', { fields: { metrics: ['clicks'] } }],
    [
      'a calculated name that is already a metric',
      {
        fields: { calculated: [{ name: 'impressions', formula: 'impressions * 2' }] },
      },
    ],
    [
      'too many decimals',
      {
        fields: { calculated: [{ name: 'cost', formula: 'impressions', decimals: 9 }] },
      },
    ],
    ['an unknown key', { fields: null, enabled: false }],
  ])('PATCH answers 400 for %s', async (_name, payload) => {
    const res = await build().inject({
      method: 'PATCH',
      url: `/webhooks/${WEBHOOK}`,
      payload,
      headers: auth,
    })
    expect(res.statusCode).toBe(400)
  })

  it('preview answers 400 for a period start without an end', async () => {
    const res = await build().inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/preview`,
      payload: { period_start: '2026-09-07' },
      headers: auth,
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /webhooks/:id', () => {
  it('answers 422 with the field and the position of a formula that does not parse', async () => {
    const db = fakeDb()
    const res = await build(db.db).inject({
      method: 'PATCH',
      url: `/webhooks/${WEBHOOK}`,
      payload: {
        fields: { calculated: [{ name: 'cost', formula: 'impressions / 1000 * price)' }] },
      },
      headers: auth,
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      error: 'invalid_formula',
      message: 'calculated field "cost": unexpected ")" at 27',
    })
    expect(db.matching('SET payload_fields')).toEqual([])
  })

  it('answers 404 for a webhook that does not exist', async () => {
    const res = await build(fakeDb().db).inject({
      method: 'PATCH',
      url: `/webhooks/${WEBHOOK}`,
      payload: { fields: null },
      headers: auth,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'webhook_not_found' })
  })
})

describe('POST /webhooks/:id/preview', () => {
  it('answers with the body a delivery would carry, and stores nothing', async () => {
    const body = { version: 1, delivery_id: null, campaigns: [] }
    const db = fakeDb((text) => {
      if (text.includes('FROM app.webhook\n WHERE id')) return [webhookRow({ enabled: false })]
      if (text.includes('app.build_webhook_payload')) return [{ payload: body }]
      return []
    })

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/preview`,
      payload: { period_start: '2026-09-07', period_end: '2026-09-13' },
      headers: auth,
    })

    // A disabled webhook can be previewed: that is how a field list is checked before it goes live.
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(body)
    expect(at(db.matching('app.build_webhook_payload')).params).toEqual([
      WEBHOOK,
      '2026-09-07',
      '2026-09-13',
    ])
    expect(db.matching('webhook_delivery')).toEqual([])
  })

  it('answers 404 for a webhook that does not exist', async () => {
    const res = await build(fakeDb().db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/preview`,
      headers: auth,
    })
    expect(res.statusCode).toBe(404)
  })
})
