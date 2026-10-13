import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { CampaignDeps } from '../../src/modules/campaigns/service.ts'
import type { Config } from '../../src/core/config.ts'
import type { Db } from '../../src/core/db.ts'
import { createLogger } from '../../src/core/log.ts'
import { createDefaultRegistry } from '../../src/modules/sync/connectors/index.ts'

// POST /inbound/salesforce/opportunities before it reaches the service: its own token, the body,
// its limit. What the service does with the records is tests/integration/inbound.test.ts.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const INBOUND = 'a-different-inbound-token-for-salesforce-0123'

const withoutInbound: Config = {
  databaseUrl: 'postgresql://x',
  databaseSsl: 'disable',
  databaseSslCa: undefined,
  adminToken: ADMIN,
  port: 0,
  logLevel: 'silent',
  trustProxyHops: 0,
  syncSchedulerEnabled: false,
  webhookSchedulerEnabled: false,
}
const config: Config = { ...withoutInbound, inboundCampaignsToken: INBOUND }

const untouchable: Db = {
  query: () => Promise.reject(new Error('database reached')),
  withTransaction: () => Promise.reject(new Error('database reached')),
  withAdvisoryLock: () => Promise.reject(new Error('database reached')),
  stats: () => ({ total: 0, idle: 0, waiting: 0 }),
  close: () => Promise.resolve(),
}

const apps: FastifyInstance[] = []
function build(appConfig: Config = config): FastifyInstance {
  const campaigns: CampaignDeps = {
    db: untouchable,
    registry: createDefaultRegistry(),
    log: createLogger('silent'),
  }
  const app = buildApp({
    config: appConfig,
    db: untouchable,
    logger: createLogger('silent'),
    campaigns,
  })
  apps.push(app)
  return app
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

const URL = '/inbound/salesforce/opportunities'

const push = (app: FastifyInstance, headers: Record<string, string>, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: URL,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  })

describe('POST /inbound/salesforce/opportunities', () => {
  it.each([
    ['no token', {}],
    ['the wrong token', bearer('not-the-inbound-token-not-the-inbound-token')],
    ['the admin token', bearer(ADMIN)],
  ])('answers 401 to %s, before reading the body', async (_name, headers) => {
    const res = await push(build(), headers, [])
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })

  it('opens no admin route to the inbound token', async () => {
    const app = build()
    for (const url of ['/campaigns', '/companies', '/webhooks', '/sync/runs/x']) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(INBOUND) })
      expect(res.statusCode, url).toBe(401)
    }
  })

  it('does not exist without its token, whatever is sent', async () => {
    const app = build(withoutInbound)
    expect((await push(app, bearer(INBOUND), [])).statusCode).toBe(404)
    expect((await push(app, bearer(ADMIN), [])).statusCode).toBe(404)
  })

  it('answers 404 under /inbound for anything else, still behind its token', async () => {
    const app = build()
    const anonymous = await app.inject({ method: 'GET', url: '/inbound/companies' })
    const known = await app.inject({
      method: 'GET',
      url: '/inbound/companies',
      headers: bearer(INBOUND),
    })
    expect([anonymous.statusCode, known.statusCode]).toEqual([401, 404])
  })

  it('no longer takes the daily report', async () => {
    const res = await build().inject({
      method: 'POST',
      url: '/inbound/campaigns',
      headers: bearer(INBOUND),
      payload: { source: 'salesforce_report', record_count: 0, campaigns: [] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('answers an empty list with an empty summary, without touching the database', async () => {
    const res = await push(build(), bearer(INBOUND), [])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      received: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: [],
      rejected: [],
      warnings: [],
    })
  })

  it('reports a record it cannot read, by position, without touching the database', async () => {
    const res = await push(build(), bearer(INBOUND), {
      Id: '006-not-an-id',
      Campaign_Start_Date__c: '2026-10-12',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      received: 1,
      rejected: [{ record: 0, opportunityId: null, error: 'invalid_record' }],
    })
  })

  it('skips a campaign starting before 2026, without touching the database', async () => {
    const res = await push(build(), bearer(INBOUND), [
      { Id: '006Aa00000BcDeFgHI', Campaign_Start_Date__c: '2025-12-31' },
    ])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      received: 1,
      skipped: [{ record: 0, opportunityId: '006Aa00000BcDeFgHI' }],
      rejected: [],
    })
  })

  it.each<[string, unknown]>([
    ['text', 'opportunities'],
    ['null', null],
    ['more than 200 records', Array.from({ length: 201 }, () => ({}))],
  ])('answers 400 to a body that is %s', async (_name, body) => {
    const res = await push(build(), bearer(INBOUND), body)
    expect(res.statusCode).toBe(400)
  })

  it('reads a delivery larger than the 64 KiB admin limit, and refuses one above 4 MiB', async () => {
    const app = build()
    // Every record is unreadable, so the database is never reached: it got past the body limit.
    const large = Array.from({ length: 200 }, () => ({ Description: 'x'.repeat(10_000) }))
    const tooLarge = [{ Description: 'x'.repeat(4.5 * 1024 * 1024) }]
    const read = await push(app, bearer(INBOUND), large)
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ received: 200 })
    expect((await push(app, bearer(INBOUND), tooLarge)).statusCode).toBe(413)
  })
})
