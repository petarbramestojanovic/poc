import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import { createHttpClient } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import { createWebhook, type NewWebhook } from '../../src/modules/webhooks/admin.ts'
import { payloadFieldsSchema, type PayloadFieldsInput } from '../../src/modules/webhooks/fields.ts'
import { reportBodySchemaFor } from '../../src/modules/webhooks/payload.ts'
import { deliverDueDeliveries, enqueueDueWebhooks } from '../../src/modules/webhooks/scheduler.ts'
import { sendNow, type SendDeps } from '../../src/modules/webhooks/send.ts'
import { verifyBody } from '../../src/modules/webhooks/sign.ts'
import type { Lookup } from '../../src/modules/webhooks/ssrf.ts'
import { at } from '../helpers.ts'

// Migration 0008 and the rows behind it, against the real schema: a Tchibo-style webhook — Date,
// Campaign, a fixed Ad Type, impressions, clicks, a cost and a CTR, all from Zeus — over an agency
// with several campaigns. The fixture is built so the rules can break:
//   * 2026-09-07 has a German and a French row: one report row of 2002 impressions costs 31.21,
//     while the two languages costed apart would add up to 31.20,
//   * an internal event CTA (100 clicks) must not count as clicks, and a day without click rows
//     must give empty clicks and CTR, not 0,
//   * an archived campaign with Zeus numbers in the week must not appear; one whose flight ended
//     in June but has Zeus numbers in the week must; NEXD numbers never appear,
//   * a report waits for a campaign in flight whose Zeus link has not been synced through the
//     period — but not for an archived one, nor one whose flight is over.

const COMPANY = '00000000-0000-4000-8000-000000000701'
const PRICED = '00000000-0000-4000-8000-000000000711'
const ARCHIVED = '00000000-0000-4000-8000-000000000712'
const FINISHED = '00000000-0000-4000-8000-000000000713'
const LATE_DATA = '00000000-0000-4000-8000-000000000714'
const UNDATED = '00000000-0000-4000-8000-000000000715'
const NEXD_LINK = '00000000-0000-4000-8000-000000000721'
const ZEUS_LINK = '00000000-0000-4000-8000-000000000722'
const ARCHIVED_LINK = '00000000-0000-4000-8000-000000000723'
const FINISHED_LINK = '00000000-0000-4000-8000-000000000724'
const NEXD_CREDENTIAL = '00000000-0000-4000-8000-000000000011'
const ZEUS_CREDENTIAL = '00000000-0000-4000-8000-000000000012'

const MONDAY = new Date('2026-09-14T03:00:00Z') // 05:00 in Zurich
const PERIOD = { from: '2026-09-07', to: '2026-09-13' }
const BASE = 'https://analytics.example.com'

const FIELDS: PayloadFieldsInput = {
  columns: [
    { name: 'Ad Type', value: 'Dynamic Ad' },
    { name: 'Impressions', formula: 'impressions', decimals: 0 },
    { name: 'Clicks', formula: 'clicks', decimals: 0 },
    { name: 'Cost', formula: 'impressions / 1000 * price' },
    { name: 'CTR', formula: 'clicks / impressions', decimals: 4 },
  ],
}
const NAMES = ['Date', 'Campaign', 'Ad Type', 'Impressions', 'Clicks', 'Cost', 'CTR']

/** The week as the client receives it. */
const WEEK = [
  {
    Date: '2026-09-07',
    Campaign: 'ITF A Priced',
    'Ad Type': 'Dynamic Ad',
    Impressions: 2002,
    Clicks: 10,
    Cost: 31.21,
    CTR: 0.005,
  },
  {
    Date: '2026-09-08',
    Campaign: 'ITF A Priced',
    'Ad Type': 'Dynamic Ad',
    Impressions: 1001,
    Clicks: 30,
    Cost: 15.6,
    CTR: 0.03,
  },
  {
    Date: '2026-09-08',
    Campaign: 'ITF C Finished',
    'Ad Type': 'Dynamic Ad',
    Impressions: 50,
    Clicks: null,
    Cost: null,
    CTR: null,
  },
  {
    Date: '2026-09-09',
    Campaign: 'ITF A Priced',
    'Ad Type': 'Dynamic Ad',
    Impressions: 500,
    Clicks: 5,
    Cost: 7.79,
    CTR: 0.01,
  },
  {
    Date: '2026-09-10',
    Campaign: 'ITF A Priced',
    'Ad Type': 'Dynamic Ad',
    Impressions: 100,
    Clicks: null,
    Cost: 1.56,
    CTR: null,
  },
]

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

describe('webhook rows (migration 0008)', () => {
  let db: Db
  const apps: FastifyInstance[] = []

  const deps = (
    fetchStub: typeof fetch = () => Promise.resolve(new Response('ok')),
    now: Date = MONDAY,
  ): SendDeps => ({
    db,
    http: createHttpClient({ log: createLogger('silent'), fetch: fetchStub, maxRetries: 0 }),
    log: createLogger('silent'),
    exportBaseUrl: BASE,
    now: () => now,
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
    frequency: 'weekly',
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
    await db.query('DELETE FROM external.sync_state WHERE link_id = ANY ($1::uuid[])', [
      [NEXD_LINK, ZEUS_LINK, ARCHIVED_LINK, FINISHED_LINK],
    ])
    await db.query(`UPDATE app.campaign SET ends_on = '2026-09-30' WHERE id = $1`, [PRICED])
  }

  /** The nightly sync wrote Zeus through `day` for the priced campaign. */
  const syncedThrough = (day: string) =>
    db.query(
      `INSERT INTO external.sync_state (link_id, data_complete_through, last_synced_at)
       VALUES ($1, $2, now())`,
      [ZEUS_LINK, day],
    )

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    await cleanup()
    await db.query('DELETE FROM app.campaign WHERE company_id = $1', [COMPANY])
    await db.query('DELETE FROM app.company WHERE id = $1', [COMPANY])

    await db.query(`INSERT INTO app.company (id, name) VALUES ($1, 'ITF Agency GmbH')`, [COMPANY])
    await db.query(
      `INSERT INTO app.campaign
         (id, company_id, name, primary_source, starts_on, ends_on, status, price, currency)
       VALUES
         ($2, $1, 'ITF A Priced',    'zeus', '2026-09-01', '2026-09-30', 'active',   15.5876, 'EUR'),
         ($3, $1, 'ITF B Archived',  'zeus', '2026-09-01', '2026-09-30', 'archived', 20,      'EUR'),
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
       VALUES ($1, $5, 'nexd', $8, 'de', '{}'),
              ($2, $5, 'zeus', $9, 'de', '{"clickthrough_cta_id": "clickthrough"}'),
              ($3, $6, 'zeus', $9, 'de', '{"clickthrough_cta_id": "clickthrough"}'),
              ($4, $7, 'zeus', $9, 'de', '{"clickthrough_cta_id": "clickthrough"}')`,
      [
        NEXD_LINK,
        ZEUS_LINK,
        ARCHIVED_LINK,
        FINISHED_LINK,
        PRICED,
        ARCHIVED,
        FINISHED,
        NEXD_CREDENTIAL,
        ZEUS_CREDENTIAL,
      ],
    )
    await db.query(
      `INSERT INTO analytics.advanced_analytics
         (campaign_id, source, language, campaign_tag, events_date, impressions, in_view,
          game_started, dwell_avg_ms, data_source)
       VALUES
         ($1, 'zeus', 'de', 'z1', '2026-09-07', 1001,  800, NULL, NULL,    'sync'),
         ($1, 'zeus', 'fr', 'z1', '2026-09-07', 1001,  700, NULL, NULL,    'sync'),
         ($1, 'zeus', 'de', 'z1', '2026-09-08', 1001,  900, NULL, NULL,    'sync'),
         ($1, 'zeus', 'de', 'z2', '2026-09-09',  500,  400, NULL, NULL,    'sync'),
         ($1, 'zeus', 'de', 'z1', '2026-09-10',  100,   90, NULL, NULL,    'sync'),
         ($1, 'nexd', 'de', 'n1', '2026-09-07', 1200, 1000, 100,  1000.00, 'sync'),
         ($2, 'zeus', 'de', 'z9', '2026-09-08',  999,  900, NULL, NULL,    'sync'),
         ($3, 'zeus', 'de', 'z8', '2026-09-08',   50,   40, NULL, NULL,    'sync'),
         ($4, 'nexd', 'de', 'n1', '2026-09-08',   50,   40, NULL, NULL,    'sync')`,
      [PRICED, ARCHIVED, FINISHED, LATE_DATA],
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

  const stored = async (webhookId: string) =>
    at(
      await db.query<{ id: string; payload: string }>(
        'SELECT id, payload FROM app.webhook_delivery WHERE webhook_id = $1',
        [webhookId],
      ),
    )

  const dueNow = (id: string) =>
    db.query('UPDATE app.webhook SET next_run_at = $2 WHERE id = $1', [id, MONDAY])

  it('refuses a stored column list that is not an object', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())
    await expect(
      db.query(`UPDATE app.webhook SET payload_fields = '[]'::jsonb WHERE id = $1`, [created.id]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a key without its header, and a header name the column does not allow', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())
    await expect(
      db.query(`UPDATE app.webhook SET auth_token = 'x' WHERE id = $1`, [created.id]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      db.query(`UPDATE app.webhook SET auth_header = 'X Evil', auth_token = 'x' WHERE id = $1`, [
        created.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      db.query(`UPDATE app.webhook SET format = 'xml' WHERE id = $1`, [created.id]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('creates a webhook with its columns and names the campaigns that will lack values', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/webhooks',
      payload: { ...webhook(), fields: FIELDS },
      headers: auth,
    })

    expect(res.statusCode).toBe(201)
    const body = res.json<{ webhook: { id: string; fields: Json }; warnings: string[] }>()
    expect(body.warnings).toEqual([
      'these campaigns are not linked to zeus, so they have no rows until they are: ITF D Late Data, ITF E Undated',
      'these campaigns have no price, so Cost will be empty for them until one is set: ITF C Finished',
    ])
    // Stored with its defaults, so what is listed is exactly what runs.
    expect(body.webhook.fields).toEqual(payloadFieldsSchema.parse(FIELDS))
    const [row] = await db.query<{ payload_version: number; report_window: string }>(
      'SELECT payload_version, report_window FROM app.webhook WHERE id = $1',
      [body.webhook.id],
    )
    expect(row).toEqual({ payload_version: 2, report_window: 'previous_week' })
  })

  it('refuses a formula its source can never compute, with 422', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        ...webhook(),
        fields: { columns: [{ name: 'Dwell', formula: 'dwell_avg_ms / 1000' }] },
      },
      headers: auth,
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      error: 'invalid_formula',
      message: 'column "Dwell": zeus does not measure dwell_avg_ms, so it can never have a value',
    })
    const rows = await db.query('SELECT id FROM app.webhook WHERE company_id = $1', [COMPANY])
    expect(rows).toEqual([])
  })

  it('delivers one row per campaign and day, languages merged, every column from that row', async () => {
    await syncedThrough('2026-09-13')
    const { webhook: created, secret } = await createWebhook(deps(), webhook())
    await dueNow(created.id)
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

    expect(await enqueueDueWebhooks(deps(receiver))).toMatchObject({ enqueued: 1, waiting: 0 })
    expect(await deliverDueDeliveries(deps(receiver))).toEqual({ attempted: 1, delivered: 1 })

    const { id, payload } = await stored(created.id)
    // The client verified the signed bytes, and they are the bytes stored.
    expect(at(received).verified).toBe(true)
    expect(at(received).body).toBe(payload)

    // The body is exactly what its own contract describes.
    const body = reportBodySchemaFor(NAMES).parse(JSON.parse(payload)) as {
      delivery_id: string
      rows: Json[]
    }
    expect(body.delivery_id).toBe(id)
    // Not the archived campaign; not NEXD's numbers; the June campaign with Zeus numbers in the
    // week is there; 31.21 is 2002 impressions costed once; the internal "Sound on" clicks are not
    // clicks; a day without click rows has no clicks and no CTR.
    expect(body.rows).toEqual(WEEK)
  })

  it('waits for a campaign in flight whose sync has not written the period', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())
    await dueNow(created.id)

    // Never synced.
    expect(await enqueueDueWebhooks(deps())).toMatchObject({ enqueued: 0, waiting: 1 })
    // Synced, but a day short.
    await syncedThrough('2026-09-12')
    expect(await enqueueDueWebhooks(deps())).toMatchObject({ enqueued: 0, waiting: 1 })
    // The archived campaign's and the June campaign's links were never synced, and do not count.
    await db.query(
      `UPDATE external.sync_state SET data_complete_through = '2026-09-13' WHERE link_id = $1`,
      [ZEUS_LINK],
    )
    expect(await enqueueDueWebhooks(deps())).toMatchObject({ enqueued: 1, waiting: 0 })
  })

  it('needs a campaign that ends inside the period synced only through its last day', async () => {
    await db.query(`UPDATE app.campaign SET ends_on = '2026-09-10' WHERE id = $1`, [PRICED])
    await syncedThrough('2026-09-10')
    const { webhook: created } = await createWebhook(deps(), webhook())
    await dueNow(created.id)

    expect(await enqueueDueWebhooks(deps())).toMatchObject({ enqueued: 1, waiting: 0 })
  })

  it('reports only the campaigns it lists', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook({ campaignIds: [FINISHED] }))

    const res = await app().inject({
      method: 'POST',
      url: `/webhooks/${created.id}/preview`,
      payload: { period_start: PERIOD.from, period_end: PERIOD.to },
      headers: auth,
    })

    expect(res.statusCode).toBe(200)
    const preview = res.json<{ rowCount: number; document: string }>()
    expect(preview.rowCount).toBe(1)
    expect((JSON.parse(preview.document) as { rows: Json[] }).rows).toEqual([WEEK[2]])
  })

  it('previews exactly what a delivery stores, and stores nothing', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())

    const res = await app().inject({
      method: 'POST',
      url: `/webhooks/${created.id}/preview`,
      headers: auth,
    })
    expect(res.statusCode).toBe(200)
    const preview = res.json<{ document: string }>().document
    expect(
      await db.query('SELECT id FROM app.webhook_delivery WHERE webhook_id = $1', [created.id]),
    ).toEqual([])

    const { deliveryId } = await sendNow(deps(), { webhookId: created.id, deliverNow: false })
    const { payload } = await stored(created.id)
    // The same text, but for the id the stored one carries.
    expect(payload).toBe(preview.replace('"delivery_id":null', `"delivery_id":"${deliveryId}"`))
  })

  it("stores a csv webhook's report as the CSV a Funnel import reads", async () => {
    const { webhook: created } = await createWebhook(
      deps(),
      webhook({ format: 'csv', auth: { token: 'fnl_it_token' } }),
    )

    await sendNow(deps(), { webhookId: created.id, period: PERIOD, deliverNow: false })

    expect((await stored(created.id)).payload).toBe(
      'Date,Campaign,Ad Type,Impressions,Clicks,Cost,CTR\r\n' +
        '2026-09-07,ITF A Priced,Dynamic Ad,2002,10,31.21,0.005\r\n' +
        '2026-09-08,ITF A Priced,Dynamic Ad,1001,30,15.6,0.03\r\n' +
        '2026-09-08,ITF C Finished,Dynamic Ad,50,,,\r\n' +
        '2026-09-09,ITF A Priced,Dynamic Ad,500,5,7.79,0.01\r\n' +
        '2026-09-10,ITF A Priced,Dynamic Ad,100,,1.56,\r\n',
    )
  })

  it('changes a webhook through PATCH and never shows the key it stores', async () => {
    const instance = app()
    const created = await instance.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        ...webhook(),
        fields: FIELDS,
        auth: { header: 'x-api-key', token: 'it-key-4711' },
      },
      headers: auth,
    })
    const id = created.json<{ webhook: { id: string } }>().webhook.id
    expect(created.body).not.toContain('it-key-4711')

    const patched = await instance.inject({
      method: 'PATCH',
      url: `/webhooks/${id}`,
      payload: { frequency: 'monthly', campaignIds: [PRICED] },
      headers: auth,
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json<{ webhook: Json }>().webhook).toMatchObject({
      frequency: 'monthly',
      scheduleCron: '0 5 1 * *',
      campaignIds: [PRICED],
      auth: { header: 'x-api-key' },
    })

    const listed = await instance.inject({ method: 'GET', url: '/webhooks', headers: auth })
    expect(listed.body).not.toContain('it-key-4711')
    const [row] = await db.query<{ auth_token: string; report_window: string }>(
      'SELECT auth_token, report_window FROM app.webhook WHERE id = $1',
      [id],
    )
    expect(row).toEqual({ auth_token: 'it-key-4711', report_window: 'previous_month' })
  })

  it('rebuilds a failed period when it is sent again, under the same id', async () => {
    const { webhook: created } = await createWebhook(deps(), webhook())
    const first = await sendNow(deps(), {
      webhookId: created.id,
      period: PERIOD,
      deliverNow: false,
    })
    await db.query(
      `UPDATE app.webhook_delivery SET status = 'failed', attempts = 6, payload = to_jsonb('stale'::text)
        WHERE id = $1`,
      [first.deliveryId],
    )

    const second = await sendNow(deps(), {
      webhookId: created.id,
      period: PERIOD,
      deliverNow: false,
    })

    expect(second.deliveryId).toBe(first.deliveryId)
    const body = JSON.parse((await stored(created.id)).payload) as {
      delivery_id: string
      rows: Json[]
    }
    expect(body.delivery_id).toBe(first.deliveryId)
    expect(body.rows).toEqual(WEEK)
  })
})
