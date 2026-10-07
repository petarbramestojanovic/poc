import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { campaignSetupSchema } from '../../src/campaigns/input.ts'
import { setUpCampaign } from '../../src/campaigns/service.ts'
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

// The admin API end to end, over HTTP and against the real schema: a campaign as the Salesforce
// report leaves it (no platform ids yet), the ids a person then gives it, the sync engine accepting
// them, and a webhook reporting it. Every row hangs off a company named 'IT Routes …' and platform
// ids start with 'it-routes-'.

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

const zeusIds = (over: Record<string, unknown> = {}) => ({
  campaignId: 'it-routes-18',
  idType: 'internal_id',
  pixels: [{ code: 'it-routes-eng', role: 'engagement' }],
  ...over,
})

interface Detail {
  id: string
  name: string
  primarySource: string
  links: {
    id: string
    source: string
    config: Record<string, unknown>
    entities: { level: string; externalId: string; role: string | null }[]
  }[]
}
interface Change {
  outcome: string
  campaign: Detail
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

  const deps = () => ({ db, registry: createDefaultRegistry(), log: createLogger('silent') })

  /** A campaign the way the Salesforce report creates one: no platform ids. */
  const seed = async (name = 'IT Routes Cafemio', ref = 'it-routes-006-1') =>
    (
      await setUpCampaign(
        deps(),
        campaignSetupSchema.parse({
          externalRef: { system: 'salesforce', id: ref },
          company: {
            name: 'IT Routes Rauch',
            externalRef: { system: 'salesforce', id: 'it_routes_rauch' },
          },
          name,
          startsOn: '2026-06-30',
          endsOn: '2026-09-30',
        }),
      )
    ).campaign

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: auth, payload: payload as Record<string, unknown> })
  const get = (url: string) => app.inject({ method: 'GET', url, headers: auth })
  const put = (id: string, platform: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: `/campaigns/${id}/platforms/${platform}`,
      headers: auth,
      payload,
    })
  const remove = (id: string, platform: string) =>
    app.inject({ method: 'DELETE', url: `/campaigns/${id}/platforms/${platform}`, headers: auth })

  /** One synced day through the real engine, with Zeus itself scripted. */
  const syncOneDay = async (linkId: string) => {
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
    return { summary, seen }
  }

  it('lists a campaign from the report before it has any platform id', async () => {
    const campaign = await seed()

    const list = await get(`/campaigns?companyId=${campaign.companyId}`)
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject([
      {
        id: campaign.id,
        name: 'IT Routes Cafemio',
        companyName: 'IT Routes Rauch',
        primarySource: 'zeus',
        externalRef: { system: 'salesforce', id: 'it-routes-006-1' },
        links: [],
      },
    ])
    const companies = (await get('/companies')).json<{ name: string }[]>()
    expect(companies.find((company) => company.name === 'IT Routes Rauch')).toMatchObject({
      campaigns: 1,
      externalRef: { system: 'salesforce', id: 'it_routes_rauch' },
    })
  })

  it('gives a campaign its Zeus ids, and the sync engine takes them as they are', async () => {
    const campaign = await seed()

    const res = await put(campaign.id, 'zeus', zeusIds())
    expect(res.statusCode).toBe(200)
    const { outcome, campaign: detail } = res.json<Change>()
    expect(outcome).toBe('created')
    expect(detail.links).toMatchObject([
      {
        source: 'zeus',
        config: { clickthrough_cta_id: 'clickthrough', campaign_id_param: 'internal_id' },
        entities: [
          { level: 'campaign', externalId: 'it-routes-18', role: null },
          { level: 'pixel', externalId: 'it-routes-eng', role: 'engagement' },
        ],
      },
    ])

    const { summary, seen } = await syncOneDay(at(detail.links).id)
    expect(summary.daysWritten).toBe(1)
    expect(seen.map((entity) => [entity.level, entity.externalId, entity.role])).toEqual([
      ['campaign', 'it-routes-18', null],
      ['pixel', 'it-routes-eng', 'engagement'],
    ])
    // The click landed on the CTA the preset created.
    const clicks = await db.query<{ cta_counter: string }>(
      'SELECT cta_counter FROM analytics.cta_clicks WHERE campaign_id = $1',
      [campaign.id],
    )
    expect(clicks.map((row) => Number(row.cta_counter))).toEqual([12])
  })

  it('adds ids, and changes nothing for ids it already has', async () => {
    const campaign = await seed()
    await put(campaign.id, 'zeus', zeusIds())

    const again = await put(campaign.id, 'zeus', zeusIds())
    const more = await put(
      campaign.id,
      'zeus',
      zeusIds({
        pixels: [
          { code: 'it-routes-eng', role: 'engagement' },
          { code: 'it-routes-fin', role: 'finish' },
        ],
      }),
    )

    expect(again.json<Change>().outcome).toBe('unchanged')
    expect(more.json<Change>().outcome).toBe('added')
    expect(at(more.json<Change>().campaign.links).entities.map((e) => e.externalId)).toEqual([
      'it-routes-18',
      'it-routes-eng',
      'it-routes-fin',
    ])
  })

  it('replaces a wrong id while the platform has no data, and forgets its sync state', async () => {
    const campaign = await seed()
    const wrong = await put(
      campaign.id,
      'zeus',
      zeusIds({ campaignId: 'it-routes-81', idType: 'external_id' }),
    )
    const wrongLink = at(wrong.json<Change>().campaign.links).id
    // A sync that covered days and found nothing under the wrong id.
    await db.query(
      `INSERT INTO external.sync_state (link_id, data_complete_through) VALUES ($1, '2026-09-30')`,
      [wrongLink],
    )

    const fixed = await put(campaign.id, 'zeus', zeusIds())

    expect(fixed.statusCode).toBe(200)
    const { outcome, campaign: detail } = fixed.json<Change>()
    expect(outcome).toBe('replaced')
    expect(at(detail.links)).toMatchObject({
      config: { campaign_id_param: 'internal_id' },
      entities: [
        { level: 'campaign', externalId: 'it-routes-18' },
        { level: 'pixel', externalId: 'it-routes-eng' },
      ],
    })
    expect(
      await db.query(
        `SELECT 1 FROM external.sync_state s JOIN external.campaign_link l ON l.id = s.link_id
          WHERE l.campaign_id = $1`,
        [campaign.id],
      ),
    ).toEqual([])
    // The wrong id belongs to nobody any more.
    expect(
      await db.query(`SELECT 1 FROM external.link_entity WHERE external_id = 'it-routes-81'`),
    ).toEqual([])
  })

  it('keeps the ids a platform has written analytics with: they can only be added to', async () => {
    const campaign = await seed()
    const created = await put(campaign.id, 'zeus', zeusIds())
    await syncOneDay(at(created.json<Change>().campaign.links).id)

    const changed = await put(campaign.id, 'zeus', zeusIds({ campaignId: 'it-routes-19' }))
    const dropped = await put(campaign.id, 'zeus', zeusIds({ pixels: [] }))
    const otherKind = await put(campaign.id, 'zeus', zeusIds({ idType: 'external_id' }))
    const removed = await remove(campaign.id, 'zeus')
    for (const res of [changed, dropped, otherKind, removed]) {
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'platform_has_data' })
    }

    const added = await put(
      campaign.id,
      'zeus',
      zeusIds({
        pixels: [
          { code: 'it-routes-eng', role: 'engagement' },
          { code: 'it-routes-fin', role: 'finish' },
        ],
      }),
    )
    expect(added.json<Change>().outcome).toBe('added')

    // The rule is per platform: NEXD has written nothing for this campaign, so it can still change.
    await put(campaign.id, 'nexd', { creatives: [{ liveId: 'it-routes-nx-1' }] })
    const nexd = await put(campaign.id, 'nexd', { creatives: [{ liveId: 'it-routes-nx-2' }] })
    expect(nexd.json<Change>().outcome).toBe('replaced')
  })

  it('changes no id while a sync is fetching with them', async () => {
    const campaign = await seed()
    const created = await put(campaign.id, 'zeus', zeusIds())
    await db.query(
      `INSERT INTO external.sync_run (link_id, trigger, window_from, window_to)
       VALUES ($1, 'manual', '2026-09-01', '2026-09-01')`,
      [at(created.json<Change>().campaign.links).id],
    )

    const changed = await put(campaign.id, 'zeus', zeusIds({ campaignId: 'it-routes-19' }))
    const removed = await remove(campaign.id, 'zeus')

    for (const res of [changed, removed]) {
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'sync_in_progress' })
    }
  })

  it('moves the headline with the platforms the campaign has ids for', async () => {
    const campaign = await seed()
    const headline = (res: Awaited<ReturnType<typeof put>>) =>
      res.json<Change>().campaign.primarySource

    const nexdOnly = await put(campaign.id, 'nexd', { creatives: [{ liveId: 'it-routes-nx-1' }] })
    const both = await put(campaign.id, 'zeus', zeusIds())
    const zeusRemoved = await remove(campaign.id, 'zeus')
    const noneLeft = await remove(campaign.id, 'nexd')
    const gone = await remove(campaign.id, 'nexd')

    expect([headline(nexdOnly), headline(both)]).toEqual(['nexd', 'zeus'])
    expect(zeusRemoved.json<Detail>().primarySource).toBe('nexd')
    expect(noneLeft.json<Detail>()).toMatchObject({ primarySource: 'zeus', links: [] })
    expect(gone.statusCode).toBe(404)
    expect(gone.json()).toMatchObject({ error: 'platform_not_found' })
  })

  it('names the campaign that already owns a platform id', async () => {
    const first = await seed()
    const twin = await seed('IT Routes Twin', 'it-routes-006-2')
    await put(first.id, 'zeus', zeusIds())

    const res = await put(twin.id, 'zeus', zeusIds())

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'entity_in_use' })
    expect(res.json<{ message: string }>().message).toContain('IT Routes Cafemio')
  })

  it('answers 404 for a campaign that does not exist', async () => {
    const dead = '00000000-0000-4000-8000-00000000dead'
    const responses = [
      await get(`/campaigns/${dead}`),
      await put(dead, 'zeus', zeusIds()),
      await remove(dead, 'zeus'),
    ]
    expect(responses.map((res) => res.statusCode)).toEqual([404, 404, 404])
    expect(responses.map((res) => res.json<{ error: string }>().error)).toEqual([
      'campaign_not_found',
      'campaign_not_found',
      'campaign_not_found',
    ])
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
      const { companyId } = await seed()

      const created = await post('/webhooks', webhook(companyId))
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
      const { companyId } = await seed()
      const res = await post('/webhooks', webhook(companyId, over))
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ error: code })
    })

    it('reports a campaign once it has its platform ids', async () => {
      const campaign = await seed()
      await put(campaign.id, 'zeus', zeusIds())
      const created = (await post('/webhooks', webhook(campaign.companyId))).json<{
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
