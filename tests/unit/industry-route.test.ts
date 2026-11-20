import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import type { Db } from '../../src/core/db.ts'
import { createHttpClient } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import type { CampaignDeps } from '../../src/modules/campaigns/service.ts'
import type { IndustryDeps } from '../../src/modules/industries/service.ts'
import { createDefaultRegistry } from '../../src/modules/sync/connectors/index.ts'

// PUT /campaigns/:id/industry and GET /industries over a scripted database: who may call them,
// what they accept, and how the database's answer becomes theirs. Against the real schema:
// tests/integration/industries.test.ts.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const INBOUND = 'a-different-inbound-token-for-salesforce-0123'
const ID = '00000000-0000-4000-8000-000000000002'

const config: Config = {
  databaseUrl: 'postgresql://x',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: ADMIN,
  inboundCampaignsToken: INBOUND,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
  emailReportSchedulerEnabled: false,
}

interface Call {
  text: string
  params: unknown[]
}

/** A database that answers every query with `answer`, recording what it was asked. */
function scriptedDb(answer: (call: Call) => unknown[]): { db: Db; calls: Call[] } {
  const calls: Call[] = []
  const reached = () => Promise.reject(new Error('not scripted'))
  const db: Db = {
    query: <T>(text: string, params: unknown[] = []) => {
      const call = { text, params }
      calls.push(call)
      try {
        return Promise.resolve(answer(call) as T[])
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
    withTransaction: reached,
    withAdvisoryLock: reached,
    stats: () => ({ total: 0, idle: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  } as Db
  return { db, calls }
}

const apps: FastifyInstance[] = []
function build(db: Db, { withIndustries = true } = {}): FastifyInstance {
  const log = createLogger('silent')
  const campaigns: CampaignDeps = { db, registry: createDefaultRegistry(), log }
  const industries: IndustryDeps = { db, http: createHttpClient({ log }), log }
  const app = buildApp({
    config,
    db,
    logger: log,
    campaigns,
    ...(withIndustries ? { industries } : {}),
  })
  apps.push(app)
  return app
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const put = (
  app: FastifyInstance,
  payload: unknown,
  headers: Record<string, string> = bearer(ADMIN),
  id = ID,
) =>
  app.inject({
    method: 'PUT',
    url: `/campaigns/${id}/industry`,
    headers,
    payload: payload as object,
  })

const nothing = () => {
  throw new Error('the database must not be reached')
}

describe('PUT /campaigns/:id/industry', () => {
  it.each([
    ['no token', {}],
    ['the inbound token', bearer(INBOUND)],
    ['a wrong token', bearer('not-the-operator-token-not-the-operator')],
  ])('answers 401 to %s, before the database', async (_name, headers) => {
    const { db, calls } = scriptedDb(nothing)
    const res = await put(build(db), { industry: 'Retail' }, headers)
    expect(res.statusCode).toBe(401)
    expect(calls).toEqual([])
  })

  it.each([
    ['an empty name', { industry: '' }],
    ['a blank name', { industry: '   ' }],
    ['no industry', {}],
    ['another field', { industry: 'Retail', source: 'llm' }],
    ['a number', { industry: 7 }],
  ])('answers 400 to %s, before the database', async (_name, payload) => {
    const { db, calls } = scriptedDb(nothing)
    const res = await put(build(db), payload)
    expect(res.statusCode).toBe(400)
    expect(calls).toEqual([])
  })

  it('answers 400 to an id that is not one', async () => {
    const { db } = scriptedDb(nothing)
    expect((await put(build(db), { industry: 'Retail' }, bearer(ADMIN), 'nope')).statusCode).toBe(
      400,
    )
  })

  it('sets it by hand, trimmed, in one statement', async () => {
    const { db, calls } = scriptedDb(() => [
      { id: ID, industry: 'Retail', industry_source: 'manual' },
    ])
    const res = await put(build(db), { industry: '  Retail ' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: ID, industry: 'Retail', industrySource: 'manual' })
    expect(calls.map((call) => call.params)).toEqual([[ID, 'Retail']])
    expect(calls[0]?.text).toContain('UPDATE app.campaign')
  })

  it('clears both with null', async () => {
    const { db, calls } = scriptedDb(() => [{ id: ID, industry: null, industry_source: null }])
    const res = await put(build(db), { industry: null })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: ID, industry: null, industrySource: null })
    expect(calls.map((call) => call.params)).toEqual([[ID, null]])
  })

  it('answers 400 unknown_industry when the foreign key refuses the name, without quoting it', async () => {
    const { db } = scriptedDb(() => {
      throw Object.assign(new Error('violates foreign key constraint "campaign_industry_fkey"'), {
        code: '23503',
        constraint: 'campaign_industry_fkey',
        detail: 'Key (industry)=(Pharma) is not present in table "industry".',
      })
    })
    const res = await put(build(db), { industry: 'Pharma' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'unknown_industry' })
    expect(res.body).not.toContain('Pharma')
  })

  it('answers 404 campaign_not_found when no campaign has the id', async () => {
    const { db } = scriptedDb(() => [])
    const res = await put(build(db), { industry: 'Retail' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'campaign_not_found' })
  })

  it('does not exist without the industries deps', async () => {
    const { db } = scriptedDb(nothing)
    expect(
      (await put(build(db, { withIndustries: false }), { industry: 'Retail' })).statusCode,
    ).toBe(404)
  })
})

describe('GET /industries', () => {
  it('needs the operator token, and the inbound token is not it', async () => {
    const { db, calls } = scriptedDb(nothing)
    const app = build(db)
    expect((await app.inject({ method: 'GET', url: '/industries' })).statusCode).toBe(401)
    const inbound = await app.inject({
      method: 'GET',
      url: '/industries',
      headers: bearer(INBOUND),
    })
    expect(inbound.statusCode).toBe(401)
    expect(calls).toEqual([])
  })

  it('lists the names and definitions the database has, in its order', async () => {
    const rows = [
      { name: 'Automotive', definition: 'Car Manufacturers' },
      { name: 'Retail', definition: 'Own stores' },
    ]
    const { db } = scriptedDb(() => rows)
    const res = await build(db).inject({
      method: 'GET',
      url: '/industries',
      headers: bearer(ADMIN),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(rows)
  })

  it('answers 404 under /industries for anything else, still behind the token', async () => {
    const { db } = scriptedDb(nothing)
    const app = build(db)
    const anonymous = await app.inject({ method: 'POST', url: '/industries' })
    const known = await app.inject({ method: 'POST', url: '/industries', headers: bearer(ADMIN) })
    expect([anonymous.statusCode, known.statusCode]).toEqual([401, 404])
  })
})
