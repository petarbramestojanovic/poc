import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import type { Db } from '../../src/core/db.ts'
import { createLogger, type Logger } from '../../src/core/log.ts'
import { EXPORT_LINK_TTL_MS, exportLink } from '../../src/modules/webhooks/exports.ts'
import { fakeDb, fakeHttp, response } from './webhook-fakes.ts'

// GET /exports/<delivery-id>.csv: public, and the signed link is the only key. Whatever is wrong
// with a request, the answer is the same 404, and the signature never reaches a log line.

const TOKEN = 'a-long-enough-operator-token-0123456789'
const ID = '9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1'
const SECRET = 'whsec_2f8c1e9a7b4d6f0e3a5c7b9d1f2e4a6c'
const BASE = 'https://analytics.example.com'
const NOW = new Date('2026-10-09T03:10:02Z')
const CSV = 'Date,Campaign,Cost\r\n2026-10-08,DE2610 Tchibo Caffè Crema,1875.99\r\n'

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

const exportRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  webhook_id: '00000000-0000-4000-8000-0000000009b0',
  payload: CSV,
  secret: SECRET,
  format: 'csv',
  enabled: true,
  ...over,
})

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function build(
  options: { row?: Record<string, unknown> | null; now?: Date; logger?: Logger } = {},
) {
  const row = options.row === undefined ? exportRow() : options.row
  const db = fakeDb((text) => (text.includes('FROM app.webhook_delivery d') && row ? [row] : []))
  const logger = options.logger ?? createLogger('silent')
  const app = buildApp({
    config,
    db: db.db,
    logger,
    webhooks: {
      db: db.db,
      http: fakeHttp(() => response(200)).http,
      log: logger,
      exportBaseUrl: BASE,
      now: () => options.now ?? NOW,
    },
  })
  apps.push(app)
  return { app, db }
}

/** The path and query of a link as deliver.ts would POST it, signed at `signedAt`. */
function linkPath(signedAt: Date = NOW, id = ID, secret = SECRET): string {
  const url = new URL(exportLink(BASE, id, secret, signedAt))
  return `${url.pathname}${url.search}`
}

describe('GET /exports/:file', () => {
  it('serves the stored CSV, byte for byte, without the operator token', async () => {
    const { app } = build()

    const res = await app.inject({ method: 'GET', url: linkPath() })

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(CSV)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${ID}.csv"`)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('works until a week after the attempt that sent it, and not a second longer', async () => {
    const signedAt = new Date('2026-10-02T03:10:02Z')
    const lastSecond = new Date(signedAt.getTime() + EXPORT_LINK_TTL_MS - 1_000)
    expect(
      (await build({ now: lastSecond }).app.inject({ url: linkPath(signedAt) })).statusCode,
    ).toBe(200)
    const expired = new Date(signedAt.getTime() + EXPORT_LINK_TTL_MS)
    expect((await build({ now: expired }).app.inject({ url: linkPath(signedAt) })).statusCode).toBe(
      404,
    )
  })

  it.each<[string, () => string, Record<string, unknown> | null]>([
    ['no signature', () => `/exports/${ID}.csv`, exportRow()],
    ['a signature of another secret', () => linkPath(NOW, ID, 'whsec_other'), exportRow()],
    [
      "another delivery's signature",
      () =>
        linkPath(NOW, '9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d2').replace(
          '9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d2',
          ID,
        ),
      exportRow(),
    ],
    [
      'an expiry moved later',
      () =>
        linkPath().replace(/exp=(\d+)/, (_m, exp: string) => `exp=${String(Number(exp) + 3_600)}`),
      exportRow(),
    ],
    [
      'a name that is not a delivery id',
      () => linkPath().replace(`${ID}.csv`, '..%2Fsecret.csv'),
      exportRow(),
    ],
    ['another extension', () => linkPath().replace('.csv', '.json'), exportRow()],
    ['an unknown delivery', () => linkPath(), null],
    ['a json webhook', () => linkPath(), exportRow({ format: 'json', payload: '{"version":2}' })],
    ['a disabled webhook', () => linkPath(), exportRow({ enabled: false })],
  ])('answers 404 for %s', async (_name, path, row) => {
    const res = await build({ row }).app.inject({ method: 'GET', url: path() })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found' })
  })

  it('logs each answer by delivery id, and never the signature', async () => {
    const lines: string[] = []
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString())
        done()
      },
    })
    const { app } = build({ logger: createLogger('debug', sink) })
    const path = linkPath()
    const sig = new URLSearchParams(path.split('?')[1]).get('sig') ?? ''

    await app.inject({ method: 'GET', url: path })
    await app.inject({ method: 'GET', url: path.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`) })

    const log = lines.join('')
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    expect(log).not.toContain(sig)
    expect(log).toContain('csv export fetched')
    expect(log).toContain('"reason":"signature"')
    expect(log).toContain(ID)
  })

  it('does not exist without the webhook machinery', async () => {
    const db: Db = fakeDb().db
    const app = buildApp({ config, db, logger: createLogger('silent') })
    apps.push(app)
    expect((await app.inject({ url: linkPath() })).statusCode).toBe(404)
  })
})
