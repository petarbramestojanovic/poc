import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { CampaignDeps } from '../../src/campaigns/service.ts'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db.ts'
import { createLogger } from '../../src/log.ts'
import { createDefaultRegistry } from '../../src/sync/connectors/index.ts'

const TOKEN = 'a-long-enough-operator-token-0123456789'
const ID = '00000000-0000-4000-8000-000000000002'
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

// Every case here is refused before the service runs, so the database must never be reached.
const untouchable: Db = {
  query: () => Promise.reject(new Error('database reached')),
  withTransaction: () => Promise.reject(new Error('database reached')),
  withAdvisoryLock: () => Promise.reject(new Error('database reached')),
  stats: () => ({ total: 0, idle: 0, waiting: 0 }),
  close: () => Promise.resolve(),
}

const apps: FastifyInstance[] = []
function build(): FastifyInstance {
  const campaigns: CampaignDeps = {
    db: untouchable,
    registry: createDefaultRegistry(),
    log: createLogger('silent'),
  }
  const app = buildApp({ config, db: untouchable, logger: createLogger('silent'), campaigns })
  apps.push(app)
  return app
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const valid = {
  company: { name: 'Rauch' },
  name: 'RO2607 Rauch Cafemio',
  sources: { zeus: { campaignId: '18', idType: 'internal_id' } },
}

describe('campaign setup routes, refused before the service', () => {
  it.each([
    ['GET', '/companies'],
    ['POST', '/companies'],
    ['GET', '/campaigns'],
    ['POST', '/campaigns'],
    ['GET', `/campaigns/${ID}`],
    ['PATCH', `/campaigns/${ID}`],
    ['DELETE', `/campaigns/${ID}`],
  ] as const)('%s %s needs the operator token', async (method, url) => {
    const res = await build().inject({ method, url })
    expect(res.statusCode).toBe(401)
  })

  it.each<{ name: string; payload: Record<string, unknown>; message: string }>([
    { name: 'no company', payload: { ...valid, company: undefined }, message: 'company' },
    { name: 'a blank name', payload: { ...valid, name: '  ' }, message: 'name' },
    {
      name: 'an end before the start',
      payload: { ...valid, startsOn: '2026-09-30', endsOn: '2026-06-30' },
      message: 'endsOn is before startsOn',
    },
    {
      name: 'an impossible date',
      payload: { ...valid, startsOn: '2026-02-31' },
      message: 'startsOn',
    },
    {
      name: 'a timezone that is not one',
      payload: { ...valid, timezone: 'Zurich' },
      message: 'IANA',
    },
    { name: 'a status we do not have', payload: { ...valid, status: 'paused' }, message: 'status' },
    {
      name: 'a Zeus id without saying which id it is',
      payload: { ...valid, sources: { zeus: { campaignId: '18' } } },
      message: 'idType',
    },
    {
      name: 'a platform without a preset',
      payload: { ...valid, sources: { adnuntius: { id: '1' } } },
      message: 'adnuntius',
    },
    {
      name: 'an external reference with a system that is not a slug',
      payload: { ...valid, externalRef: { system: 'Sales Force', id: '006' } },
      message: 'slug',
    },
    { name: 'an unknown field', payload: { ...valid, industry: 'food' }, message: 'industry' },
    {
      name: 'a price without its currency',
      payload: { ...valid, price: { value: 20.4 } },
      message: 'currency',
    },
    {
      name: 'a currency that is not a code',
      payload: { ...valid, price: { value: 20.4, currency: 'eur' } },
      message: 'ISO 4217',
    },
    {
      name: 'a currency code that does not exist',
      payload: { ...valid, price: { value: 20.4, currency: 'EUX' } },
      message: 'ISO 4217',
    },
    {
      // The column holds four decimals and Postgres would round a fifth without a word.
      name: 'a price with a fifth decimal',
      payload: { ...valid, price: { value: 15.58761, currency: 'EUR' } },
      message: '4 decimal places',
    },
    {
      name: 'a negative price',
      payload: { ...valid, price: { value: -1, currency: 'EUR' } },
      message: 'price',
    },
    {
      name: 'a price sent as text',
      payload: { ...valid, price: { value: '20.4', currency: 'EUR' } },
      message: 'price',
    },
    {
      name: 'the total instead of the unit price',
      payload: { ...valid, price: { amount: 8160, currency: 'EUR' } },
      message: 'amount',
    },
  ])('POST /campaigns rejects $name with 400', async ({ payload, message }) => {
    const res = await build().inject({ method: 'POST', url: '/campaigns', headers: auth, payload })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain(message)
  })

  it.each<{ name: string; payload: Record<string, unknown> }>([
    { name: 'an empty patch', payload: {} },
    { name: 'a patch that touches links', payload: { sources: {} } },
    { name: 'a patch that moves the campaign', payload: { company: { id: ID } } },
    { name: 'dates out of order', payload: { startsOn: '2026-09-30', endsOn: '2026-06-30' } },
    { name: 'a price without its currency', payload: { price: { value: 20.4 } } },
    {
      name: 'a price with a fifth decimal',
      payload: { price: { value: 0.12345, currency: 'EUR' } },
    },
  ])('PATCH /campaigns/:id rejects $name with 400', async ({ payload }) => {
    const res = await build().inject({
      method: 'PATCH',
      url: `/campaigns/${ID}`,
      headers: auth,
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a malformed id and a malformed company filter with 400', async () => {
    const app = build()
    const byId = await app.inject({ method: 'GET', url: '/campaigns/42', headers: auth })
    const byCompany = await app.inject({
      method: 'GET',
      url: '/campaigns?companyId=rauch',
      headers: auth,
    })
    expect([byId.statusCode, byCompany.statusCode]).toEqual([400, 400])
  })

  it('has no delete: removing a campaign would erase its analytics', async () => {
    const res = await build().inject({ method: 'DELETE', url: `/campaigns/${ID}`, headers: auth })
    expect(res.statusCode).toBe(404)
  })
})

describe('without the campaign machinery', () => {
  it('answers 404 under the prefix, still behind the token', async () => {
    const app = buildApp({ config, db: untouchable, logger: createLogger('silent') })
    apps.push(app)
    expect((await app.inject({ method: 'GET', url: '/campaigns' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/campaigns', headers: auth })).statusCode).toBe(
      404,
    )
  })
})
