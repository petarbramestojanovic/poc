import { fastify } from 'fastify'
import { describe, expect, it } from 'vitest'
import { requireAdminToken, tokenMatches } from '../../src/plugins/admin-auth.ts'

const TOKEN = 'correct-horse-battery-staple'

async function appWithAuth() {
  const app = fastify()
  app.register(async (scope) => {
    scope.addHook('onRequest', requireAdminToken(TOKEN))
    scope.get('/sync/ping', async () => ({ ok: true }))
  })
  await app.ready()
  return app
}

describe('admin auth', () => {
  it('tokenMatches compares in constant time without leaking on length', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches('x', TOKEN)).toBe(false)
    expect(tokenMatches(undefined, TOKEN)).toBe(false)
  })

  it.each([
    ['no header', {}],
    ['wrong token', { authorization: 'Bearer nope' }],
    ['wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['trailing garbage', { authorization: `Bearer ${TOKEN} extra` }],
  ])('returns 401 with %s', async (_name, headers) => {
    const app = await appWithAuth()
    const res = await app.inject({ method: 'GET', url: '/sync/ping', headers })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })

  it('lets a valid bearer token through', async () => {
    const app = await appWithAuth()
    const res = await app.inject({
      method: 'GET',
      url: '/sync/ping',
      headers: { authorization: `bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})
