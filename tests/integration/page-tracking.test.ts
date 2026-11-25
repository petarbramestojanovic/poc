import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, limitDb, type Db } from '../../src/core/db.ts'
import { createLimiter } from '../../src/core/limiter.ts'
import { createLogger } from '../../src/core/log.ts'
import { charLength, TRACKED_FIELDS } from '../../src/modules/tracking/event.ts'
import { PAGE_MAX_CONNECTIONS, type TrackingDeps } from '../../src/modules/tracking/routes.ts'

// The public page tracker end to end: POST /pages/event over HTTP, counted in the local database by
// the real upsert. What must hold under load and abuse: one row per combination however many posts
// race for it, a count never lost or doubled, nothing written for a campaign that is not there, the
// cap on new combinations, and the tracker never taking the connections a sync needs.
//
// The campaigns and their company are this file's own (ids 0000…0019xx, names 'IT Page Tracking');
// no other test file writes them. Rows are removed after each test, the campaigns after the file.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'

const COMPANY = '00000000-0000-4000-8000-000000001900'
const ACTIVE = '00000000-0000-4000-8000-000000001911'
const DRAFT = '00000000-0000-4000-8000-000000001912'
const ARCHIVED = '00000000-0000-4000-8000-000000001913'
const SECOND = '00000000-0000-4000-8000-000000001914'
const CAMPAIGNS = [ACTIVE, DRAFT, ARCHIVED, SECOND]

const config: Config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: ADMIN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
  emailReportSchedulerEnabled: false,
}

interface StoredRow {
  campaign_id: string
  source: string
  language: string
  events_date: string
  overflow: boolean
  referrer: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_content: string
  utm_term: string
  brame_1: string
  brame_2: string
  brame_3: string
  visits: number
  conversions: number
}

describe('the page tracker against the database', () => {
  const log = createLogger('silent')
  let db: Db
  const apps: FastifyInstance[] = []

  beforeAll(async () => {
    db = createDb(config.databaseUrl, { ssl: 'disable', logger: log, max: 4 })
    await db.query(`INSERT INTO app.company (id, name) VALUES ($1, 'IT Page Tracking Company')`, [
      COMPANY,
    ])
    await db.query(
      `INSERT INTO app.campaign (id, company_id, name, primary_source, status)
       VALUES ($1, $5, 'IT Page Tracking Active', 'nexd', 'active'),
              ($2, $5, 'IT Page Tracking Draft', 'nexd', 'draft'),
              ($3, $5, 'IT Page Tracking Archived', 'nexd', 'archived'),
              ($4, $5, 'IT Page Tracking Second', 'nexd', 'active')`,
      [ACTIVE, DRAFT, ARCHIVED, SECOND, COMPANY],
    )
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
    await db.query('DELETE FROM analytics.utm_daily WHERE campaign_id = ANY($1::uuid[])', [
      CAMPAIGNS,
    ])
  })

  afterAll(async () => {
    await db.query('DELETE FROM app.campaign WHERE id = ANY($1::uuid[])', [CAMPAIGNS])
    await db.query('DELETE FROM app.company WHERE id = $1', [COMPANY])
    await db.close()
  })

  /** The app as index.ts wires it: the tracker on its own two-connection share of the pool. */
  function build(over: Partial<TrackingDeps> = {}): FastifyInstance {
    // The app closes the pool it is given; the tracker's share must not close the shared one.
    const shared: Db = { ...db, close: () => Promise.resolve() }
    const app = buildApp({
      config,
      db: shared,
      logger: log,
      tracking: {
        db: limitDb(shared, createLimiter(PAGE_MAX_CONNECTIONS)),
        log,
        combinationCap: 2_000,
        ...over,
      },
    })
    apps.push(app)
    return app
  }

  const post = (app: FastifyInstance, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/pages/event',
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': BROWSER },
      payload: JSON.stringify(body),
    })

  async function rows(campaign = ACTIVE): Promise<StoredRow[]> {
    const found = await db.query<StoredRow & { visits: string; conversions: string }>(
      `SELECT campaign_id, source, language, events_date, overflow, referrer, utm_source, utm_medium,
              utm_campaign, utm_content, utm_term, brame_1, brame_2, brame_3, visits, conversions
         FROM analytics.utm_daily WHERE campaign_id = $1
        ORDER BY events_date, overflow, language, utm_source, utm_medium, referrer`,
      [campaign],
    )
    return found.map((row) => ({
      ...row,
      visits: Number(row.visits),
      conversions: Number(row.conversions),
    }))
  }

  const empty = Object.fromEntries(TRACKED_FIELDS.map((field) => [field, ''])) as Record<
    (typeof TRACKED_FIELDS)[number],
    string
  >

  it('stores each of the nine values in its own column (the upsert is positional)', async () => {
    const app = build({ now: () => new Date('2026-11-24T10:00:00Z') })
    const sent = Object.fromEntries(TRACKED_FIELDS.map((field) => [field, `v-${field}`]))
    sent.referrer = 'https://news.example.com/a'
    const res = await post(app, { campaign_id: ACTIVE, language: 'de', ...sent })
    expect(res.statusCode).toBe(204)
    expect(await rows()).toEqual([
      {
        campaign_id: ACTIVE,
        source: 'brame',
        language: 'de',
        events_date: '2026-11-24',
        overflow: false,
        ...sent,
        visits: 1,
        conversions: 0,
      },
    ])
  })

  it('makes exactly one row of 50 posts racing for the same new combination', async () => {
    const app = build()
    const answers = await Promise.all(
      Array.from({ length: 50 }, () => post(app, { campaign_id: ACTIVE, utm_source: 'Race' })),
    )
    expect(answers.map((res) => res.statusCode)).toEqual(Array(50).fill(204))
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ utm_source: 'Race', visits: 50, conversions: 0 })
  })

  it('adds a conversion to the row of the visit it came from', async () => {
    const app = build({ now: () => new Date('2026-11-24T10:00:00Z') })
    const values = {
      utm_source: 'Brame',
      utm_medium: 'display',
      referrer: 'https://www.google.com/',
    }
    await post(app, { campaign_id: ACTIVE, ...values })
    await post(app, { campaign_id: ACTIVE, ...values })
    await post(app, { campaign_id: ACTIVE, event: 'conversion', ...values })
    expect(await rows()).toEqual([
      expect.objectContaining({ ...values, visits: 2, conversions: 1 }),
    ])
  })

  it('counts a conversion on a later day on that day, with no visit', async () => {
    let now = new Date('2026-11-24T10:00:00Z')
    const app = build({ now: () => now })
    await post(app, { campaign_id: ACTIVE, utm_source: 'Brame' })
    now = new Date('2026-11-26T10:00:00Z')
    await post(app, { campaign_id: ACTIVE, event: 'conversion', utm_source: 'Brame' })
    expect((await rows()).map((r) => [r.events_date, r.visits, r.conversions])).toEqual([
      ['2026-11-24', 1, 0],
      ['2026-11-26', 0, 1],
    ])
  })

  it('splits days at midnight in Zurich (the brame day zone), not at midnight UTC', async () => {
    let now = new Date('2026-11-24T22:59:59Z')
    const app = build({ now: () => now })
    await post(app, { campaign_id: ACTIVE })
    now = new Date('2026-11-24T23:00:01Z')
    await post(app, { campaign_id: ACTIVE })
    expect((await rows()).map((r) => [r.events_date, r.visits])).toEqual([
      ['2026-11-24', 1],
      ['2026-11-25', 1],
    ])
  })

  it('keeps languages apart', async () => {
    const app = build()
    await post(app, { campaign_id: ACTIVE, language: 'de', utm_source: 'a' })
    await post(app, { campaign_id: ACTIVE, language: 'fr', utm_source: 'a' })
    await post(app, { campaign_id: ACTIVE, utm_source: 'a' })
    expect((await rows()).map((r) => r.language).sort()).toEqual(['', 'de', 'fr'])
  })

  it('stores hostile values as plain text, cleaned and cut', async () => {
    const app = build()
    const hostile = {
      utm_source: "'); DROP TABLE analytics.utm_daily; --",
      utm_medium: "O'Reilly",
      utm_campaign: 'tab\there\u0000null',
      utm_content: 'x'.repeat(5_000), // the body stays under 8 KB
      utm_term: '🎉'.repeat(300),
      brame_1: '<img src=x onerror=alert(1)>',
      referrer: 'https://evil.example.com/p?token=abc#frag',
    }
    const res = await post(app, { campaign_id: ACTIVE, ...hostile })
    expect(res.statusCode).toBe(204)
    const [row] = await rows()
    expect(row).toMatchObject({
      utm_source: "'); DROP TABLE analytics.utm_daily; --",
      utm_medium: "O'Reilly",
      utm_campaign: 'tabherenull',
      brame_1: '<img src=x onerror=alert(1)>',
      referrer: 'https://evil.example.com/p',
      visits: 1,
    })
    expect(charLength(row?.utm_content ?? '')).toBe(255)
    expect(row?.utm_term).toBe(`${'🎉'.repeat(254)}…`)
    // And the same hostile post again lands on the same row.
    await post(app, { campaign_id: ACTIVE, ...hostile })
    expect((await rows()).map((r) => r.visits)).toEqual([2])
  })

  it('writes nothing for a campaign that is not there or is archived, and counts a draft', async () => {
    const app = build()
    const missing = await post(app, {
      campaign_id: '00000000-0000-4000-8000-0000000019ff',
      utm_source: 'x',
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ error: 'unknown_campaign' })
    expect((await post(app, { campaign_id: ARCHIVED })).statusCode).toBe(404)
    expect(await rows(ARCHIVED)).toEqual([])
    expect((await post(app, { campaign_id: DRAFT })).statusCode).toBe(204)
    expect((await rows(DRAFT)).map((r) => r.visits)).toEqual([1])
    const [count] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM analytics.utm_daily
        WHERE campaign_id = '00000000-0000-4000-8000-0000000019ff'`,
    )
    expect(count?.n).toBe('0')
  })

  describe('the cap on new combinations', () => {
    it('puts a new combination over the cap on the day overflow row, and loses no visit', async () => {
      let now = new Date('2026-11-24T10:00:00Z')
      const app = build({ combinationCap: 3, now: () => now })
      for (const source of ['a', 'b', 'c'])
        await post(app, { campaign_id: ACTIVE, utm_source: source })
      await post(app, { campaign_id: ACTIVE, utm_source: 'd' }) // over the cap
      await post(app, { campaign_id: ACTIVE, utm_source: 'e', event: 'conversion' }) // over the cap
      await post(app, { campaign_id: ACTIVE, utm_source: 'b' }) // known: still its own row
      expect(
        (await rows()).map((r) => [r.overflow, r.utm_source, r.visits, r.conversions]),
      ).toEqual([
        [false, 'a', 1, 0],
        [false, 'b', 2, 0],
        [false, 'c', 1, 0],
        [true, '', 1, 1],
      ])

      // A new day starts with room again.
      now = new Date('2026-11-25T10:00:00Z')
      await post(app, { campaign_id: ACTIVE, utm_source: 'd' })
      expect((await rows()).filter((r) => r.events_date === '2026-11-25')).toEqual([
        expect.objectContaining({ overflow: false, utm_source: 'd', visits: 1 }),
      ])
    })

    it('counts per campaign: one campaign over the cap leaves another its room', async () => {
      const app = build({ combinationCap: 1 })
      await post(app, { campaign_id: ACTIVE, utm_source: 'a' })
      await post(app, { campaign_id: ACTIVE, utm_source: 'b' })
      await post(app, { campaign_id: SECOND, utm_source: 'b' })
      expect((await rows(SECOND)).map((r) => [r.overflow, r.utm_source])).toEqual([[false, 'b']])
    })

    it('counts every language of the campaign toward the same cap', async () => {
      const app = build({ combinationCap: 2 })
      await post(app, { campaign_id: ACTIVE, language: 'de', utm_source: 'a' })
      await post(app, { campaign_id: ACTIVE, language: 'fr', utm_source: 'a' })
      await post(app, { campaign_id: ACTIVE, language: 'it', utm_source: 'a' })
      // The overflow row keeps the language, so a language's total stays right.
      expect((await rows()).map((r) => [r.overflow, r.language, r.utm_source])).toEqual([
        [false, 'de', 'a'],
        [false, 'fr', 'a'],
        [true, 'it', ''],
      ])
    })

    it('holds under a flood of random combinations: a bounded number of rows, every visit counted', async () => {
      const app = build({ combinationCap: 20, maxInFlight: 10_000 })
      const answers = await Promise.all(
        Array.from({ length: 300 }, (_, i) =>
          post(app, { campaign_id: ACTIVE, utm_source: `random-${String(i)}` }),
        ),
      )
      expect(answers.every((res) => res.statusCode === 204)).toBe(true)
      const stored = await rows()
      const regular = stored.filter((r) => !r.overflow)
      // The cap is read before the insert; two posts racing at the edge may both get in.
      expect(regular.length).toBeGreaterThanOrEqual(20)
      expect(regular.length).toBeLessThanOrEqual(22)
      expect(stored.filter((r) => r.overflow)).toHaveLength(1)
      expect(stored.reduce((sum, r) => sum + r.visits, 0)).toBe(300)
    })
  })

  describe('the database share', () => {
    it('leaves the rest of the pool free while it is flooded', async () => {
      const app = build({ maxInFlight: 10_000 })
      const flood = Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          post(app, { campaign_id: ACTIVE, utm_source: `flood-${String(i % 5)}` }),
        ),
      )
      // The pool has 4 connections and the tracker 2 of them: a sync's query never waits for it.
      const started = Date.now()
      await db.query('SELECT 1')
      await db.query('SELECT 1')
      expect(Date.now() - started).toBeLessThan(1_000)
      const answers = await flood
      expect(answers.every((res) => res.statusCode === 204)).toBe(true)
      expect((await rows()).reduce((sum, r) => sum + r.visits, 0)).toBe(200)
    })

    it('answers 503 busy over its queue, and counts exactly the posts it accepted', async () => {
      const app = build({ maxInFlight: 5 })
      const answers = await Promise.all(
        Array.from({ length: 100 }, () => post(app, { campaign_id: ACTIVE, utm_source: 'busy' })),
      )
      const accepted = answers.filter((res) => res.statusCode === 204).length
      const busy = answers.filter((res) => res.statusCode === 503).length
      expect(accepted + busy).toBe(100)
      expect(busy).toBeGreaterThan(0)
      expect((await rows()).map((r) => r.visits)).toEqual([accepted])
    })
  })

  it('answers OPTIONS and serves the tag without touching the database', async () => {
    const app = build()
    expect((await app.inject({ method: 'OPTIONS', url: '/pages/event' })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/pages/tag.js' })).statusCode).toBe(200)
    expect(await rows()).toEqual([])
    expect(empty.utm_source).toBe('')
  })
})
