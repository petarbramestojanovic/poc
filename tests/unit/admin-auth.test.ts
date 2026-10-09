import { fastify, type FastifyBaseLogger } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from '../../src/core/log.ts'
import { requireAdminToken, tokenMatches } from '../../src/core/plugins/admin-auth.ts'

const TOKEN = 'correct-horse-battery-staple-0123456789'

const apps: { close(): Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function appWithAuth() {
  const lines: string[] = []
  const loggerInstance: FastifyBaseLogger = createLogger('warn', {
    write: (line: string) => {
      lines.push(line)
    },
  })
  const app = fastify({ loggerInstance })
  apps.push(app)
  app.register(async (scope) => {
    scope.addHook('onRequest', requireAdminToken(TOKEN))
    scope.get('/sync/ping', async () => ({ ok: true }))
  })
  await app.ready()
  return { app, lines }
}

describe('admin auth', () => {
  it('tokenMatches compares in constant time without leaking on length', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches('x', TOKEN)).toBe(false)
    expect(tokenMatches(undefined, TOKEN)).toBe(false)
  })

  it.each([
    ['no header', {}, 'missing'],
    ['wrong token', { authorization: 'Bearer nope-not-the-token' }, 'mismatch'],
    ['wrong scheme', { authorization: `Basic ${TOKEN}` }, 'malformed'],
    ['trailing garbage', { authorization: `Bearer ${TOKEN} extra` }, 'malformed'],
  ])(
    'returns 401 with %s, uncacheable, and logs why without the value',
    async (_name, headers, reason) => {
      const { app, lines } = await appWithAuth()
      const res = await app.inject({ method: 'GET', url: '/sync/ping?x=1', headers })
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toBe('Bearer')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.json()).toEqual({ error: 'unauthorized' })

      const warning = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.msg === 'admin auth rejected')
      expect(warning).toMatchObject({ reason, path: '/sync/ping', method: 'GET' })
      expect(lines.join('')).not.toContain('nope-not-the-token')
      expect(lines.join('')).not.toContain(TOKEN)
    },
  )

  it('lets a valid bearer token through without logging', async () => {
    const { app, lines } = await appWithAuth()
    const res = await app.inject({
      method: 'GET',
      url: '/sync/ping',
      headers: { authorization: `bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(lines.filter((l) => l.includes('admin auth rejected'))).toEqual([])
  })
})
