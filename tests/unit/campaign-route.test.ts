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

const zeus = { campaignId: '18', idType: 'internal_id' }

describe('campaign routes, refused before the service', () => {
  it.each([
    ['GET', '/companies'],
    ['GET', '/campaigns'],
    ['GET', `/campaigns/${ID}`],
    ['PUT', `/campaigns/${ID}/platforms/zeus`],
    ['DELETE', `/campaigns/${ID}/platforms/nexd`],
    ['POST', '/campaigns'],
  ] as const)('%s %s needs the operator token', async (method, url) => {
    const res = await build().inject({ method, url })
    expect(res.statusCode).toBe(401)
  })

  // Campaigns and companies come from the Salesforce report, and their own fields belong to it.
  it.each([
    ['POST', '/campaigns', 'creating a campaign by hand'],
    ['PATCH', `/campaigns/${ID}`, "editing a campaign's own fields"],
    ['POST', '/companies', 'creating a company by hand'],
    ['DELETE', `/campaigns/${ID}`, 'deleting a campaign, which would erase its analytics'],
  ] as const)('%s %s does not exist: %s', async (method, url, _reason) => {
    const res = await build().inject({ method, url, headers: auth, payload: {} })
    expect(res.statusCode).toBe(404)
  })

  it.each<{ name: string; url: string; payload: Record<string, unknown>; message: string }>([
    {
      name: 'a Zeus id without saying which id it is',
      url: `/campaigns/${ID}/platforms/zeus`,
      payload: { campaignId: '18' },
      message: 'idType',
    },
    {
      name: 'a Zeus pixel without its role',
      url: `/campaigns/${ID}/platforms/zeus`,
      payload: { ...zeus, pixels: [{ code: 'px' }] },
      message: 'role',
    },
    {
      name: 'an unknown field',
      url: `/campaigns/${ID}/platforms/zeus`,
      payload: { ...zeus, name: 'renamed' },
      message: 'name',
    },
    {
      name: 'NEXD without a creative',
      url: `/campaigns/${ID}/platforms/nexd`,
      payload: { creatives: [] },
      message: 'creatives',
    },
    {
      name: 'NEXD ids under the Zeus route',
      url: `/campaigns/${ID}/platforms/zeus`,
      payload: { creatives: [{ liveId: 'nx_1' }] },
      message: 'campaignId',
    },
  ])('PUT rejects $name with 400', async ({ url, payload, message }) => {
    const res = await build().inject({ method: 'PUT', url, headers: auth, payload })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain(message)
  })

  it('has no route for a platform without a preset', async () => {
    const res = await build().inject({
      method: 'PUT',
      url: `/campaigns/${ID}/platforms/adnuntius`,
      headers: auth,
      payload: { id: '1' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a malformed id, company filter or language with 400', async () => {
    const app = build()
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/campaigns/42', headers: auth }),
      app.inject({ method: 'GET', url: '/campaigns?companyId=rauch', headers: auth }),
      app.inject({
        method: 'PUT',
        url: '/campaigns/42/platforms/zeus',
        headers: auth,
        payload: zeus,
      }),
      app.inject({
        method: 'DELETE',
        url: `/campaigns/${ID}/platforms/zeus?language=${'x'.repeat(17)}`,
        headers: auth,
      }),
    ])
    expect(responses.map((res) => res.statusCode)).toEqual([400, 400, 400, 400])
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
