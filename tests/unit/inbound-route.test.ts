import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { CampaignDeps } from '../../src/modules/campaigns/service.ts'
import type { Config } from '../../src/core/config.ts'
import type { Db } from '../../src/core/db.ts'
import { createLogger } from '../../src/core/log.ts'
import { createDefaultRegistry } from '../../src/modules/sync/connectors/index.ts'

// POST /inbound/campaigns before it reaches the service: its own token, the envelope, the body
// limit. What the service does with a report is tests/integration/inbound.test.ts.

const ADMIN = 'a-long-enough-operator-token-0123456789'
const INBOUND = 'a-different-inbound-token-for-the-report-0123'

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

const report = (over: Record<string, unknown> = {}) => ({
  source: 'salesforce_report',
  report_as_of: '2026-10-06T06:00:03',
  record_count: 0,
  campaigns: [],
  ...over,
})

const push = (app: FastifyInstance, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'POST', url: '/inbound/campaigns', headers, payload: payload as object })

describe('POST /inbound/campaigns', () => {
  it.each([
    ['no token', {}],
    ['the wrong token', bearer('not-the-inbound-token-not-the-inbound-token')],
    ['the admin token', bearer(ADMIN)],
  ])('answers 401 to %s, before reading the body', async (_name, headers) => {
    const res = await push(build(), headers, report())
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
    expect((await push(app, bearer(INBOUND), report())).statusCode).toBe(404)
    expect((await push(app, bearer(ADMIN), report())).statusCode).toBe(404)
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

  it.each<[string, Record<string, unknown>]>([
    ['another source', { source: 'hubspot' }],
    ['a count that disagrees with the rows', { record_count: 1 }],
    ['no campaigns list', { campaigns: 'none' }],
  ])('answers 400 to a body with %s', async (_name, over) => {
    const res = await push(build(), bearer(INBOUND), report(over))
    expect(res.statusCode).toBe(400)
  })

  it('reads a report larger than the 64 KiB admin limit, and refuses one above 1 MiB', async () => {
    const app = build()
    // Refused on its count, so the database is never reached: it got past the body limit.
    const large = report({ record_count: 1, unmapped_columns: [], padding: 'x'.repeat(200_000) })
    const tooLarge = report({ padding: 'x'.repeat(1_100_000) })
    expect((await push(app, bearer(INBOUND), large)).statusCode).toBe(400)
    expect((await push(app, bearer(INBOUND), tooLarge)).statusCode).toBe(413)
  })
})
