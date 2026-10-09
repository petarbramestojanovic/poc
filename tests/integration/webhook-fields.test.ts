import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import { createHttpClient } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import { createWebhook, type NewWebhook } from '../../src/modules/webhooks/admin.ts'
import {
  payloadFieldsSchema,
  payloadShapeOf,
  readStoredFields,
  type PayloadFieldsInput,
} from '../../src/modules/webhooks/fields.ts'
import {
  webhookPayloadSchema,
  webhookPayloadSchemaFor,
} from '../../src/modules/webhooks/payload.ts'
import { deliverDueDeliveries, enqueueDueWebhooks } from '../../src/modules/webhooks/scheduler.ts'
import { sendNow, type SendDeps } from '../../src/modules/webhooks/send.ts'
import { verifyBody } from '../../src/modules/webhooks/sign.ts'
import type { Lookup } from '../../src/modules/webhooks/ssrf.ts'
import { at } from '../helpers.ts'

// Migration 0007 and the field lists behind it, against the real schema: a Tchibo-style webhook
// that delivers impressions plus a cost and a CTR calculated from Zeus, for a campaign whose
// primary source is NEXD and whose webhook leaves check sources out. The fixture is built so the
// rules can break:
//   * the week's cost (2602 impressions → 40.56) is not the sum of the rounded daily costs (40.55),
//   * the Zeus block has to be added even though the webhook does not want check sources,
//   * an internal event CTA (100 clicks) must not count as clicks, and a day without click rows
//     must give a null CTR, not 0,
//   * an archived campaign and a campaign that ended months ago must not be listed, while one
//     whose flight dates are wrong but which has numbers in the week must be.

const COMPANY = '00000000-0000-4000-8000-000000000701'
const PRICED = '00000000-0000-4000-8000-000000000711'
const ARCHIVED = '00000000-0000-4000-8000-000000000712'
const FINISHED = '00000000-0000-4000-8000-000000000713'
const LATE_DATA = '00000000-0000-4000-8000-000000000714'
const UNDATED = '00000000-0000-4000-8000-000000000715'
const NEXD_LINK = '00000000-0000-4000-8000-000000000721'
const ZEUS_LINK = '00000000-0000-4000-8000-000000000722'
const NEXD_CREDENTIAL = '00000000-0000-4000-8000-000000000011'
const ZEUS_CREDENTIAL = '00000000-0000-4000-8000-000000000012'

const MONDAY = new Date('2026-09-14T06:00:00Z') // 08:00 in Zurich
const PERIOD = { from: '2026-09-07', to: '2026-09-13' }

const FIELDS: PayloadFieldsInput = {
  metrics: ['impressions'],
  sections: ['daily'],
  calculated: [
    { name: 'cost', formula: 'impressions / 1000 * price' },
    { name: 'ctr', formula: 'clicks / impressions', decimals: 4 },
  ],
}

const publicLookup: Lookup = () => Promise.resolve([{ address: '93.184.216.34' }])

const config: Config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: 'a-long-enough-operator-token-0123456789',
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
}
const auth = { authorization: `Bearer ${config.adminToken}` }

type Json = Record<string, unknown>

describe('webhook field lists (migration 0007)', () => {
  let db: Db
  const apps: FastifyInstance[] = []

  const deps = (fetchStub: typeof fetch = () => Promise.resolve(new Response('ok'))): SendDeps => ({
    db,
    http: createHttpClient({ log: createLogger('silent'), fetch: fetchStub, maxRetries: 0 }),
    log: createLogger('silent'),
    now: () => MONDAY,
    lookup: publicLookup,
  })

  /** The admin API on its own pool: app.close() closes the pool it was given. */
  function app(): FastifyInstance {
    const appDb = createDb(process.env.DATABASE_URL ?? '', { max: 2, ssl: 'disable' })
    const instance = buildApp({
      config,
      db: appDb,
      logger: createLogger('silent'),
      webhooks: { ...deps(), db: appDb },
    })
    apps.push(instance)
    return instance
  }

  const webhook = (over: Partial<NewWebhook> = {}): NewWebhook => ({
    companyId: COMPANY,
    name: 'ITF weekly',
    url: 'https://client.example.com/hook',
    scheduleCron: '0 8 * * 1',
    includeCheckSources: false,
    fields: payloadFieldsSchema.parse(FIELDS),
    ...over,
  })

  const cleanup = async () => {
    await db.query(
      `DELETE FROM app.webhook_delivery
        WHERE webhook_id IN (SELECT id FROM app.webhook WHERE company_id = $1)`,
      [COMPANY],
    )
    await db.query('DELETE FROM app.webhook WHERE company_id = $1', [COMPANY])
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    await cleanup()
    await db.query('DELETE FROM app.campaign WHERE company_id = $1', [COMPANY])
    await db.query('DELETE FROM app.company WHERE id = $1', [COMPANY])

    await db.query(`INSERT INTO app.company (id, name) VALUES ($1, 'ITF Coffee Co')`, [COMPANY])
    await db.query(
      `INSERT INTO app.campaign
         (id, company_id, name, primary_source, starts_on, ends_on, status, price, currency)
       VALUES
         ($2, $1, 'ITF A Priced',    'nexd', '2026-09-01', '2026-09-30', 'active',   15.5876, 'EUR'),
         ($3, $1, 'ITF B Archived',  'zeus', '2026-09-01', '2026-09-30', 'archived', NULL,    NULL),
         ($4, $1, 'ITF C Finished',  'zeus', '2026-06-01', '2026-06-30', 'active',   NULL,    NULL),
         ($5, $1, 'ITF D Late Data', 'nexd', '2026-06-01', '2026-06-30', 'active',   NULL,    NULL),
         ($6, $1, 'ITF E Undated',   'nexd', NULL,         NULL,         'active',   NULL,    NULL)`,
      [COMPANY, PRICED, ARCHIVED, FINISHED, LATE_DATA, UNDATED],
    )
    await db.query(
      `INSERT INTO analytics.cta (campaign_id, cta_id, name, is_internal_event, sort_order)
       VALUES ($1, 'clickthrough', 'Click-out', false, 1), ($1, 'sound', 'Sound on', true, 2)`,
      [PRICED],
    )
    await db.query(
      `INSERT INTO external.campaign_link (id, campaign_id, source_id, credential_id, language, config)
       VALUES ($1, $3, 'nexd', $4, 'de', '{}'),
              ($2, $3, 'zeus', $5, 'de', '{"clickthrough_cta_id": "clickthrough"}')`,
      [NEXD_LINK, ZEUS_LINK, PRICED, NEXD_CREDENTIAL, ZEUS_CREDENTIAL],
    )
    await db.query(
      `INSERT INTO analytics.advanced_analytics
         (campaign_id, source, language, campaign_tag, events_date, impressions, in_view,
          game_started, dwell_avg_ms, data_source)
       VALUES
         ($1, 'zeus', 'de', 'z1', '2026-09-07', 1001,  800, NULL, NULL,    'sync'),
         ($1, 'zeus', 'de', 'z1', '2026-09-08', 1001,  900, NULL, NULL,    'sync'),
         ($1, 'zeus', 'de', 'z2', '2026-09-09',  500,  400, NULL, NULL,    'sync'),
         ($1, 'zeus', 'de', 'z1', '2026-09-10',  100,   90, NULL, NULL,    'sync'),
         ($1, 'nexd', 'de', 'n1', '2026-09-07', 1200, 1000, 100,  1000.00, 'sync'),
         ($2, 'nexd', 'de', 'n1', '2026-09-08',   50,   40, NULL, NULL,    'sync')`,
      [PRICED, LATE_DATA],
    )
    await db.query(
      `INSERT INTO analytics.cta_clicks
         (campaign_id, source, language, campaign_tag, cta_id, events_date, cta_counter, data_source)
       VALUES
         ($1, 'zeus', 'de', 'z1', 'clickthrough', '2026-09-07',  10, 'sync'),
         ($1, 'zeus', 'de', 'z1', 'clickthrough', '2026-09-08',  30, 'sync'),
         ($1, 'zeus', 'de', 'z2', 'clickthrough', '2026-09-09',   5, 'sync'),
         ($1, 'zeus', 'de', 'z1', 'sound',        '2026-09-07', 100, 'sync')`,
      [PRICED],
    )
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((instance) => instance.close()))
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await db.query('DELETE FROM app.campaign WHERE company_id = $1', [COMPANY])
    await db.query('DELETE FROM app.company WHERE id = $1', [COMPANY])
    await db.close()
  })

  const storedPayload = async (webhookId: string) =>
    at(
      await db.query<{ id: string; payload: Json }>(
        'SELECT id, payload FROM app.webhook_delivery WHERE webhook_id = $1',
        [webhookId],
      ),
    )

  /** The body without the two fields that differ between two builds of the same period. */
  const comparable = (body: Json): Json => {
    const { delivery_id: _id, generated_at: _at, ...rest } = body
    return rest
  }

  const campaignNamed = (body: Json, name: string): Json => {
    const campaign = (body.campaigns as Json[]).find((entry) => entry.name === name)
    if (!campaign) throw new Error(`${name} is not in the body`)
    return campaign
  }
  const blockOf = (campaign: Json, source: string): Json => {
    const block = (campaign.sources as Json[]).find((entry) => entry.source === source)
    if (!block) throw new Error(`no ${source} block`)
    return block
  }

  it('refuses a stored field list that is not an object', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook({ fields: null }))
    await expect(
      db.query(`UPDATE app.webhook SET payload_fields = '[]'::jsonb WHERE id = $1`, [created.id]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('creates a webhook with a field list and names the campaigns it cannot compute', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/webhooks',
      payload: { ...webhook(), fields: FIELDS },
      headers: auth,
    })

    expect(res.statusCode).toBe(201)
    const body = res.json<{ webhook: { id: string; fields: Json }; warnings: string[] }>()
    expect(body.warnings).toEqual([
      'these campaigns have no price, so cost will be null for them until one is set: ITF C Finished, ITF D Late Data, ITF E Undated',
      'these campaigns are not linked to zeus, so cost, ctr will carry no value for them: ITF C Finished, ITF D Late Data, ITF E Undated',
    ])
    // Stored with its defaults, so what is listed is exactly what runs.
    expect(body.webhook.fields).toEqual(payloadFieldsSchema.parse(FIELDS))
  })

  it('refuses a formula its source can never compute, with 422', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        ...webhook(),
        fields: { calculated: [{ name: 'dwell_s', formula: 'dwell_avg_ms / 1000' }] },
      },
      headers: auth,
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      error: 'invalid_formula',
      message:
        'calculated field "dwell_s": zeus does not measure dwell_avg_ms, so it can never have a value',
    })
    const rows = await db.query('SELECT id FROM app.webhook WHERE company_id = $1', [COMPANY])
    expect(rows).toEqual([])
  })

  it('delivers cost and CTR from Zeus at every level, each from that level', async () => {
    const { webhook: created, secret } = await createWebhook(deps(), webhook())
    await db.query('UPDATE app.webhook SET next_run_at = $2 WHERE id = $1', [created.id, MONDAY])
    // The client's endpoint: verifies the signature the way the contract tells it to.
    const received: { body: string; verified: boolean }[] = []
    const receiver: typeof fetch = (_url, init) => {
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === 'string' ? init.body : ''
      received.push({
        body,
        verified: verifyBody(
          headers.get('x-timestamp') ?? undefined,
          body,
          secret,
          headers.get('x-signature') ?? undefined,
        ),
      })
      return Promise.resolve(new Response('ok'))
    }

    expect(await enqueueDueWebhooks(deps(receiver))).toEqual({ enqueued: 1, due: 1 })
    expect(await deliverDueDeliveries(deps(receiver))).toEqual({ attempted: 1, delivered: 1 })

    const { id, payload } = await storedPayload(created.id)
    // The client verified the signed bytes, and they are the bytes stored.
    expect(at(received).verified).toBe(true)
    expect(JSON.parse(at(received).body)).toEqual(payload)
    expect(payload.delivery_id).toBe(id)

    // The body is exactly what its own contract describes.
    const fields = readStoredFields(created.fields)
    if (!fields) throw new Error('no field list stored')
    webhookPayloadSchemaFor(payloadShapeOf(fields)).parse(payload)

    const priced = campaignNamed(payload, 'ITF A Priced')
    expect(priced).toMatchObject({ price: 15.5876, currency: 'EUR' })
    expect((priced.sources as Json[]).map((block) => [block.source, block.role])).toEqual([
      ['nexd', 'primary'],
      ['zeus', 'check'], // added for the formulas, although check sources are off
    ])

    const zeus = blockOf(priced, 'zeus')
    expect(zeus.metrics_available).toEqual(['impressions', 'cost', 'ctr'])
    // 2602 / 1000 × 15.5876 = 40.5589352 → 40.56, while the rounded days add up to 40.55.
    // 45 clicks: the 100 on the internal "Sound on" event are not clicks.
    expect(zeus.totals).toEqual({ impressions: 2602, cost: 40.56, ctr: 0.0173 })
    expect(zeus.daily).toEqual([
      { date: '2026-09-07', language: 'de', impressions: 1001, cost: 15.6, ctr: 0.01 },
      { date: '2026-09-08', language: 'de', impressions: 1001, cost: 15.6, ctr: 0.03 },
      { date: '2026-09-09', language: 'de', impressions: 500, cost: 7.79, ctr: 0.01 },
      // No click rows that day: the CTR is unknown, not 0.
      { date: '2026-09-10', language: 'de', impressions: 100, cost: 1.56, ctr: null },
    ])
    expect(zeus.creatives).toEqual([
      { campaign_tag: 'z1', label: null, totals: { impressions: 2102, cost: 32.77, ctr: 0.019 } },
      { campaign_tag: 'z2', label: null, totals: { impressions: 500, cost: 7.79, ctr: 0.01 } },
    ])
    expect(zeus).not.toHaveProperty('ctas')
    expect(zeus).not.toHaveProperty('pages')

    // The primary block delivers its impressions and nothing calculated: one cost per campaign.
    const nexd = blockOf(priced, 'nexd')
    expect(nexd.totals).toEqual({ impressions: 1200 })
    expect(nexd.metrics_available).toEqual(['impressions'])
  })

  it('lists only campaigns that are not archived and touch the period', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())

    const res = await app().inject({
      method: 'POST',
      url: `/webhooks/${created.id}/preview`,
      payload: { period_start: PERIOD.from, period_end: PERIOD.to },
      headers: auth,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<Json>()
    // Not the archived one, not the one that ended in June. The one whose flight says June but
    // which has numbers in the week is listed, and so is the one without dates.
    expect((body.campaigns as Json[]).map((campaign) => campaign.name)).toEqual([
      'ITF A Priced',
      'ITF D Late Data',
      'ITF E Undated',
    ])
    const late = campaignNamed(body, 'ITF D Late Data')
    expect(late).toMatchObject({ price: null, currency: null })
    // Not linked to Zeus: no Zeus block to carry a cost.
    expect((late.sources as Json[]).map((block) => block.source)).toEqual(['nexd'])
    expect(blockOf(late, 'nexd').totals).toEqual({ impressions: 50 })
  })

  it('previews exactly what a delivery stores, and stores nothing', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())
    const instance = app()

    const preview = await instance.inject({
      method: 'POST',
      url: `/webhooks/${created.id}/preview`,
      headers: auth,
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json<Json>().delivery_id).toBeNull()
    expect(
      await db.query('SELECT id FROM app.webhook_delivery WHERE webhook_id = $1', [created.id]),
    ).toEqual([])

    await sendNow(deps(), { webhookId: created.id, deliverNow: false })
    const { payload } = await storedPayload(created.id)
    expect(comparable(payload)).toEqual(comparable(preview.json<Json>()))
  })

  it('goes back to the full v1 body when the field list is removed', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())
    const instance = app()

    const patched = await instance.inject({
      method: 'PATCH',
      url: `/webhooks/${created.id}`,
      payload: { fields: null },
      headers: auth,
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json<{ webhook: { fields: unknown } }>().webhook.fields).toBeNull()

    const preview = await instance.inject({
      method: 'POST',
      url: `/webhooks/${created.id}/preview`,
      headers: auth,
    })
    const [built] = await db.query<{ payload: Json }>(
      'SELECT app.build_webhook_payload($1, $2, $3) AS payload',
      [created.id, PERIOD.from, PERIOD.to],
    )
    const body = webhookPayloadSchema.parse(preview.json())
    expect(comparable(body)).toEqual(comparable(built?.payload ?? {}))
    expect(at(body.campaigns)).not.toHaveProperty('price')
  })

  it('stores exactly the body Postgres builds for a webhook without a field list', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook({ fields: undefined }))

    await sendNow(deps(), { webhookId: created.id, period: PERIOD, deliverNow: false })

    const { payload } = await storedPayload(created.id)
    const [built] = await db.query<{ payload: Json }>(
      'SELECT app.build_webhook_payload($1, $2, $3) AS payload',
      [created.id, PERIOD.from, PERIOD.to],
    )
    expect(comparable(payload)).toEqual(comparable(built?.payload ?? {}))
    webhookPayloadSchema.parse(payload)
  })

  it('rebuilds a failed period with the field list when it is sent again', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())
    const first = await sendNow(deps(), {
      webhookId: created.id,
      period: PERIOD,
      deliverNow: false,
    })
    await db.query(
      `UPDATE app.webhook_delivery SET status = 'failed', attempts = 6,
              payload = jsonb_set(payload, '{campaigns}', '[]') WHERE id = $1`,
      [first.deliveryId],
    )

    const second = await sendNow(deps(), {
      webhookId: created.id,
      period: PERIOD,
      deliverNow: false,
    })

    expect(second.deliveryId).toBe(first.deliveryId)
    const { payload } = await storedPayload(created.id)
    expect(payload.delivery_id).toBe(first.deliveryId)
    expect(blockOf(campaignNamed(payload, 'ITF A Priced'), 'zeus').totals).toMatchObject({
      cost: 40.56,
    })
  })
})
