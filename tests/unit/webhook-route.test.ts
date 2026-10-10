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

const COLUMNS = {
  source: 'zeus',
  columns: [{ name: 'Impressions', formula: 'impressions', decimals: 0 }],
}

const webhookRow = (over: Record<string, unknown> = {}) => ({
  id: WEBHOOK,
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
  next_run_at: new Date('2026-09-21T03:00:00Z'),
  payload_fields: COLUMNS,
  ...over,
})

const metricsRow = {
  campaign_id: '00000000-0000-4000-8000-000000000002',
  campaign: 'DE2609 Tchibo Caffè Crema',
  price: null,
  events_date: '2026-09-08',
  language: 'de',
  campaign_tag: '',
  impressions: '1001',
}

/** A webhook with one stored day of Zeus numbers; the delivery insert lands under its own id. */
const withNumbers =
  (over: Record<string, unknown> = {}, metrics: unknown[] = [metricsRow]) =>
  (text: string, params: unknown[]): unknown[] => {
    if (text.includes('FROM app.webhook\n WHERE id')) return [webhookRow(over)]
    if (text.includes('FROM analytics.advanced_analytics')) return metrics
    if (text.includes('INSERT INTO app.webhook_delivery')) return [{ id: params[0] }]
    return []
  }

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
  it('answers 202 with the delivery id the stored document carries', async () => {
    const db = fakeDb(withNumbers())

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      payload: { period_start: '2026-09-07', period_end: '2026-09-13' },
      headers: auth,
    })

    expect(res.statusCode).toBe(202)
    const body = res.json<{ deliveryId: string; periodStart: string; periodEnd: string }>()
    expect(body).toMatchObject({ periodStart: '2026-09-07', periodEnd: '2026-09-13' })
    const [id, , , , trigger, document] = at(db.matching('INSERT INTO app.webhook_delivery')).params
    expect(id).toBe(body.deliveryId)
    expect(trigger).toBe('manual')
    expect(JSON.parse(document as string)).toMatchObject({ delivery_id: body.deliveryId })
  })

  it('answers 409 for a period in which no campaign has a number', async () => {
    const db = fakeDb(withNumbers({}, []))

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      headers: auth,
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'empty_period' })
    expect(db.matching('INSERT INTO app.webhook_delivery')).toEqual([])
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

  it('sends a period already delivered again, as a new delivery with its own id', async () => {
    const delivered = withNumbers()
    const db = fakeDb((text, params) =>
      text.includes('FROM app.webhook_delivery\n WHERE webhook_id')
        ? [{ id: 'delivery-1', status: 'delivered', attempts: 1 }]
        : delivered(text, params),
    )

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      headers: auth,
    })

    expect(res.statusCode).toBe(202)
    const { deliveryId } = res.json<{ deliveryId: string }>()
    expect(deliveryId).not.toBe('delivery-1')
    const [id, , , , trigger] = at(db.matching('INSERT INTO app.webhook_delivery')).params
    expect([id, trigger]).toEqual([deliveryId, 'manual'])
    // The delivered record is left as it was.
    expect(db.matching("SET status = 'pending'")).toEqual([])
  })

  it('re-queues a period whose latest delivery failed, under that id', async () => {
    const FAILED = '00000000-0000-4000-8000-0000000009f1'
    const failed = withNumbers()
    const db = fakeDb((text, params) => {
      if (text.includes('FROM app.webhook_delivery\n WHERE webhook_id')) {
        return [{ id: FAILED, status: 'failed', attempts: 6 }]
      }
      if (text.includes("SET status = 'pending'")) return [{ id: FAILED }]
      return failed(text, params)
    })

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      headers: auth,
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ deliveryId: FAILED })
    const [id, document] = at(db.matching("SET status = 'pending'")).params
    expect(id).toBe(FAILED)
    expect(JSON.parse(document as string)).toMatchObject({ delivery_id: FAILED })
    expect(db.matching('INSERT INTO app.webhook_delivery')).toEqual([])
  })
})

describe('POST /webhooks, PATCH /webhooks/:id and POST /webhooks/:id/preview, refused before the handler', () => {
  it.each([
    ['POST', '/webhooks'],
    ['PATCH', `/webhooks/${WEBHOOK}`],
    ['POST', `/webhooks/${WEBHOOK}/preview`],
  ] as const)('%s %s needs the operator token', async (method, url) => {
    const res = await build().inject({ method, url, payload: { enabled: false } })
    expect(res.statusCode).toBe(401)
  })

  const create = {
    companyId: '00000000-0000-4000-8000-000000000001',
    name: 'Tchibo daily',
    url: 'https://fileimport-webhook.funnel.io/abc',
    frequency: 'daily',
    format: 'csv',
    auth: { token: 'fnl_token' },
    fields: COLUMNS,
  }

  it.each([
    ['no frequency', { ...create, frequency: undefined }],
    ['an hourly frequency', { ...create, frequency: 'hourly' }],
    ['an xml format', { ...create, format: 'xml' }],
    ['no columns', { ...create, fields: undefined }],
    ['a version 1 field list', { ...create, fields: { metrics: ['impressions'] } }],
    ['a reportWindow, which is a frequency now', { ...create, reportWindow: 'previous_day' }],
    ['a key with a line break', { ...create, auth: { token: 'a\r\nX-Evil: 1' } }],
    ['a header name with a space', { ...create, auth: { header: 'x api', token: 'k' } }],
  ])('POST answers 400 for %s', async (_name, payload) => {
    const res = await build().inject({ method: 'POST', url: '/webhooks', payload, headers: auth })
    expect(res.statusCode).toBe(400)
  })

  it.each([
    ['nothing to change', {}],
    ['the company, which never changes', { companyId: create.companyId }],
    ['a column named Date', { fields: { columns: [{ name: 'Date', formula: 'impressions' }] } }],
    [
      'too many decimals',
      { fields: { columns: [{ name: 'C', formula: 'impressions', decimals: 9 }] } },
    ],
    ['an unknown key', { fields: COLUMNS, include_creatives: false }],
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
  it('answers 422 with the column and the position of a formula that does not parse', async () => {
    const db = fakeDb((text) =>
      text.includes('FOR UPDATE') ? [{ ...webhookRow(), auth_header: null, auth_token: null }] : [],
    )
    const res = await build(db.db).inject({
      method: 'PATCH',
      url: `/webhooks/${WEBHOOK}`,
      payload: { fields: { columns: [{ name: 'Cost', formula: 'impressions / 1000 * price)' }] } },
      headers: auth,
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      error: 'invalid_formula',
      message: 'column "Cost": unexpected ")" at 27',
    })
    expect(db.matching('UPDATE app.webhook')).toEqual([])
  })

  it('answers 404 for a webhook that does not exist', async () => {
    const res = await build(fakeDb().db).inject({
      method: 'PATCH',
      url: `/webhooks/${WEBHOOK}`,
      payload: { enabled: false },
      headers: auth,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'webhook_not_found' })
  })
})

describe('POST /webhooks/:id/preview', () => {
  it('answers with the document a delivery would carry, and stores nothing', async () => {
    // A disabled webhook can be previewed: that is how a column list is checked before it goes live.
    const db = fakeDb(withNumbers({ enabled: false, format: 'csv' }))

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/preview`,
      payload: { period_start: '2026-09-07', period_end: '2026-09-13' },
      headers: auth,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      format: 'csv',
      periodStart: '2026-09-07',
      periodEnd: '2026-09-13',
      rowCount: 1,
      document: 'Date,Campaign,Impressions\r\n2026-09-08,DE2609 Tchibo Caffè Crema,1001\r\n',
    })
    expect(at(db.matching('FROM analytics.advanced_analytics')).params.slice(2)).toEqual([
      'zeus',
      '2026-09-07',
      '2026-09-13',
    ])
    expect(db.matching('webhook_delivery')).toEqual([])
  })

  it('previews an empty period as an empty document, with no delivery id', async () => {
    const db = fakeDb(withNumbers({}, []))

    const res = await build(db.db).inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/preview`,
      headers: auth,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ rowCount: number; document: string }>()
    expect(body.rowCount).toBe(0)
    expect(JSON.parse(body.document)).toMatchObject({ delivery_id: null, rows: [] })
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
