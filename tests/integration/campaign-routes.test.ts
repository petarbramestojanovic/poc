import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { createDb, type Db } from '../../src/db.ts'
import { createHttpClient } from '../../src/http/HttpClient.ts'
import { createLimiter } from '../../src/limiter.ts'
import { createLogger } from '../../src/log.ts'
import { zeusLinkConfig } from '../../src/sync/connectors/zeus/schema.ts'
import { createDefaultRegistry } from '../../src/sync/connectors/index.ts'
import { createRunTracker, runSync, SYNC_MAX_CONNECTIONS } from '../../src/sync/engine.ts'
import { createRegistry } from '../../src/sync/registry.ts'
import type { LinkEntity, SourceConnector } from '../../src/sync/types.ts'
import { webhookPayloadSchema } from '../../src/webhooks/payload.ts'
import { at } from '../helpers.ts'

// The admin API end to end, over HTTP and against the real schema: what is typed into a form
// becomes a campaign the sync engine accepts and a webhook payload carries. Every row hangs off a
// company named 'IT Routes …' and platform ids start with 'it-routes-'.

const TOKEN = 'a-long-enough-operator-token-0123456789'
const auth = { authorization: `Bearer ${TOKEN}` }

const config: Config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: TOKEN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
}

const body = (over: Record<string, unknown> = {}) => ({
  company: { name: 'IT Routes Rauch' },
  name: 'IT Routes Cafemio',
  startsOn: '2026-06-30',
  endsOn: '2026-09-30',
  sources: {
    zeus: {
      campaignId: 'it-routes-18',
      idType: 'internal_id',
      pixels: [{ code: 'it-routes-eng', role: 'engagement' }],
    },
  },
  ...over,
})

interface SetupResponse {
  created: boolean
  company: { id: string }
  campaign: { id: string; name: string }
  links: { id: string; source: string }[]
}

describe('campaign admin API', () => {
  let db: Db
  let app: FastifyInstance

  const cleanup = async () => {
    const companies = `(SELECT id FROM app.company WHERE name LIKE 'IT Routes%')`
    await db.query(`DELETE FROM app.webhook WHERE company_id IN ${companies}`)
    await db.query(`DELETE FROM app.campaign WHERE company_id IN ${companies}`)
    await db.query(`DELETE FROM app.company WHERE name LIKE 'IT Routes%'`)
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    // app.close() closes the pool it was given, so the app gets its own.
    const appDb = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    const log = createLogger('silent')
    // send-now tries once in the background; the tracker lets app.close() wait for it.
    const tracker = createRunTracker()
    app = buildApp({
      config,
      db: appDb,
      logger: log,
      tracker,
      campaigns: { db: appDb, registry: createDefaultRegistry(), log },
      webhooks: {
        db: appDb,
        // The client endpoint: always answers 200.
        http: createHttpClient({
          log,
          maxRetries: 0,
          fetch: () => Promise.resolve(new Response('ok')),
        }),
        log,
        lookup: () => Promise.resolve([{ address: '93.184.216.34' }]),
        tracker,
      },
    })
    await cleanup()
  })
  afterEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await app.close()
    await db.close()
  })

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: auth, payload: payload as Record<string, unknown> })
  const get = (url: string) => app.inject({ method: 'GET', url, headers: auth })

  it('creates a campaign from the ids a person has, and lists it back', async () => {
    const created = await post('/campaigns', body())
    expect(created.statusCode).toBe(201)
    const setup = created.json<SetupResponse>()
    expect(setup.created).toBe(true)

    const list = await get(`/campaigns?companyId=${setup.company.id}`)
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject([
      {
        id: setup.campaign.id,
        name: 'IT Routes Cafemio',
        companyName: 'IT Routes Rauch',
        primarySource: 'zeus',
        links: [{ source: 'zeus', language: '', enabled: true, entities: 2 }],
      },
    ])

    const detail = await get(`/campaigns/${setup.campaign.id}`)
    expect(detail.json()).toMatchObject({
      links: [
        {
          config: { clickthrough_cta_id: 'clickthrough', campaign_id_param: 'internal_id' },
          entities: [
            { level: 'campaign', externalId: 'it-routes-18', role: null },
            { level: 'pixel', externalId: 'it-routes-eng', role: 'engagement' },
          ],
        },
      ],
    })
  })

  it('answers 201 for a new external reference and 200 when it comes again', async () => {
    const externalRef = { system: 'salesforce', id: 'it-routes-006' }
    const first = await post('/campaigns', body({ externalRef }))
    const second = await post('/campaigns', body({ externalRef, name: 'IT Routes Renamed' }))

    expect([first.statusCode, second.statusCode]).toEqual([201, 200])
    expect(second.json<SetupResponse>().campaign).toMatchObject({
      id: first.json<SetupResponse>().campaign.id,
      name: 'IT Routes Renamed',
    })
  })

  it('names the campaign that already owns a platform id', async () => {
    await post('/campaigns', body())
    const twin = await post(
      '/campaigns',
      body({ company: { name: 'IT Routes Other' }, name: 'IT Routes Twin' }),
    )

    expect(twin.statusCode).toBe(409)
    expect(twin.json()).toMatchObject({ error: 'entity_in_use' })
    expect(twin.json<{ message: string }>().message).toContain('IT Routes Cafemio')
  })

  it('edits a campaign and answers 404 for one that does not exist', async () => {
    const { campaign } = (await post('/campaigns', body())).json<SetupResponse>()

    const edited = await app.inject({
      method: 'PATCH',
      url: `/campaigns/${campaign.id}`,
      headers: auth,
      payload: { status: 'archived', endsOn: null },
    })
    const missing = await app.inject({
      method: 'PATCH',
      url: '/campaigns/00000000-0000-4000-8000-00000000dead',
      headers: auth,
      payload: { status: 'archived' },
    })

    expect(edited.statusCode).toBe(200)
    expect(edited.json()).toMatchObject({
      status: 'archived',
      endsOn: null,
      startsOn: '2026-06-30',
    })
    expect(missing.statusCode).toBe(404)
    expect((await get('/campaigns/00000000-0000-4000-8000-00000000dead')).statusCode).toBe(404)
  })

  it('creates a company once per external reference and lists it with its campaigns', async () => {
    const externalRef = { system: 'salesforce', id: 'it-routes-001' }
    const first = await post('/companies', { name: 'IT Routes Account', externalRef })
    const again = await post('/companies', { name: 'IT Routes Account AG', externalRef })
    const namesake = await post('/companies', { name: 'it routes account ag' })

    expect([first.statusCode, again.statusCode, namesake.statusCode]).toEqual([201, 200, 409])
    expect(again.json()).toMatchObject({
      id: first.json<{ id: string }>().id,
      name: 'IT Routes Account AG',
    })

    const listed = (await get('/companies')).json<{ name: string; campaigns: number }[]>()
    expect(listed.find((company) => company.name === 'IT Routes Account AG')).toMatchObject({
      campaigns: 0,
      externalRef,
    })
  })

  it('sets up a campaign the sync engine accepts as it is', async () => {
    const setup = (await post('/campaigns', body())).json<SetupResponse>()
    const linkId = at(setup.links).id

    // Zeus itself is scripted; its config schema and the engine around it are the real ones.
    let seen: LinkEntity[] = []
    const scripted: SourceConnector = {
      ...createDefaultRegistry().get('zeus'),
      describe: () => ({ configSchema: zeusLinkConfig }),
      fetchWindow: (ctx) => {
        seen = ctx.entities
        return Promise.resolve({
          rows: [
            {
              date: '2026-09-01',
              language: '',
              campaignTag: '',
              metrics: { impressions: 1000, game_started: 40 },
              pageViews: [],
              ctaClicks: [{ ctaId: 'clickthrough', count: 12 }],
              unmapped: new Map(),
            },
          ],
          warnings: [],
          covered: { from: '2026-09-01', to: '2026-09-01' },
        })
      },
    }

    const summary = await runSync(
      {
        db,
        registry: createRegistry([scripted]),
        http: { request: () => Promise.reject(new Error('no network in this test')) },
        log: createLogger('silent'),
        limiter: createLimiter(SYNC_MAX_CONNECTIONS),
        env: { ZEUS_API_TOKEN: 'scripted-token' },
      },
      { linkId, window: { from: '2026-09-01', to: '2026-09-01' }, trigger: 'backfill' },
    )

    expect(summary.daysWritten).toBe(1)
    expect(seen.map((entity) => [entity.level, entity.externalId, entity.role])).toEqual([
      ['campaign', 'it-routes-18', null],
      ['pixel', 'it-routes-eng', 'engagement'],
    ])
    // The click landed on the CTA the setup created.
    const clicks = await db.query<{ cta_counter: string }>(
      'SELECT cta_counter FROM analytics.cta_clicks WHERE campaign_id = $1',
      [setup.campaign.id],
    )
    expect(clicks.map((row) => Number(row.cta_counter))).toEqual([12])
  })

  describe('webhooks', () => {
    const webhook = (companyId: string, over: Record<string, unknown> = {}) => ({
      companyId,
      name: 'IT Routes weekly',
      url: 'https://client.example.com/hook',
      scheduleCron: '0 8 * * 1',
      ...over,
    })

    it('hands the signing secret over once and never lists it', async () => {
      const { company } = (await post('/campaigns', body())).json<SetupResponse>()

      const created = await post('/webhooks', webhook(company.id))
      expect(created.statusCode).toBe(201)
      const { secret, webhook: summary } = created.json<{
        secret: string
        webhook: { id: string; nextRunAt: string; campaignIds: null }
      }>()
      expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/)
      expect(summary.campaignIds).toBeNull()
      expect(new Date(summary.nextRunAt).getTime()).toBeGreaterThan(Date.now())

      const listed = await get('/webhooks')
      expect(listed.body).toContain(summary.id)
      expect(listed.body).not.toContain(secret)
      // …while the database holds exactly the secret that was handed over.
      const [row] = await db.query<{ secret: string }>(
        'SELECT secret FROM app.webhook WHERE id = $1',
        [summary.id],
      )
      expect(row?.secret).toBe(secret)
    })

    it.each([
      ['a cron that never fires', { scheduleCron: 'every monday' }, 'invalid_schedule'],
      ['a plain http target', { url: 'http://client.example.com/hook' }, 'blocked_target'],
      [
        'a campaign of another company',
        { campaignIds: ['00000000-0000-4000-8000-000000000002'] },
        'invalid_webhook',
      ],
    ])('refuses %s with 422', async (_name, over, code) => {
      const { company } = (await post('/campaigns', body())).json<SetupResponse>()
      const res = await post('/webhooks', webhook(company.id, over))
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ error: code })
    })

    it('reports a campaign that was set up through the API', async () => {
      const setup = (await post('/campaigns', body())).json<SetupResponse>()
      const created = (await post('/webhooks', webhook(setup.company.id))).json<{
        webhook: { id: string }
      }>()

      const sent = await post(`/webhooks/${created.webhook.id}/send-now`, {
        period_start: '2026-09-01',
        period_end: '2026-09-07',
      })
      expect(sent.statusCode).toBe(202)

      const [delivery] = await db.query<{ payload: unknown }>(
        'SELECT payload FROM app.webhook_delivery WHERE id = $1',
        [sent.json<{ deliveryId: string }>().deliveryId],
      )
      const payload = webhookPayloadSchema.parse(delivery?.payload)
      expect(payload.campaigns.map((campaign) => campaign.name)).toEqual(['IT Routes Cafemio'])
      expect(at(at(payload.campaigns).sources)).toMatchObject({ source: 'zeus', role: 'primary' })
    })
  })
})
