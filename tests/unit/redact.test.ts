import { describe, expect, it } from 'vitest'
import { REDACTED, redact, redactUrl } from '../../src/http/redact.ts'

describe('redact', () => {
  it('replaces credential-bearing keys at any depth, case-insensitively', () => {
    const input = {
      method: 'POST',
      headers: { Authorization: 'Bearer abc', 'x-api-key': 'k', accept: 'application/json' },
      nested: [{ token: 't', keep: 1 }],
    }
    expect(redact(input)).toEqual({
      method: 'POST',
      headers: { Authorization: REDACTED, 'x-api-key': REDACTED, accept: 'application/json' },
      nested: [{ token: REDACTED, keep: 1 }],
    })
  })

  it.each([
    'cookie',
    'set-cookie',
    'client_secret',
    'refresh_token',
    'private_key',
    'signature',
    'apikey',
  ])('redacts the %s key', (key) => {
    expect(redact({ [key]: 'value' })).toEqual({ [key]: REDACTED })
  })

  it('masks bearer tokens embedded in strings', () => {
    expect(redact('curl -H "Authorization: Bearer s3cr3t"')).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}"`,
    )
  })

  it('blanks credential query parameters in URLs and keeps the rest readable', () => {
    const url = 'https://api.test/reports?from=2026-09-01&api_key=abc123&token=t0k'
    const out = redact(url)
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('t0k')
    expect(out).toContain('from=2026-09-01')
    expect(redactUrl('https://api.test/x?from=2026-09-01')).toBe(
      'https://api.test/x?from=2026-09-01',
    )
    expect(redactUrl('not a url')).toBe('not a url')
  })

  it('handles Headers objects and leaves primitives alone', () => {
    expect(redact(new Headers({ authorization: 'Bearer x', accept: '*/*' }))).toEqual({
      authorization: REDACTED,
      accept: '*/*',
    })
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBeNull()
  })

  it('keeps a __proto__ key from third-party JSON as an own property, never as the prototype', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as unknown
    const out = redact(parsed) as Record<string, unknown>
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as { polluted?: unknown }).polluted).toBeUndefined()
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('does not mutate its input', () => {
    const input = { authorization: 'Bearer x' }
    redact(input)
    expect(input.authorization).toBe('Bearer x')
  })
})
