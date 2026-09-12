import { describe, expect, it } from 'vitest'
import { REDACTED, redact } from '../../src/http/redact.ts'

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

  it('masks bearer tokens embedded in strings', () => {
    expect(redact('curl -H "Authorization: Bearer s3cr3t"')).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}"`,
    )
  })

  it('handles Headers objects and leaves primitives alone', () => {
    expect(redact(new Headers({ authorization: 'Bearer x', accept: '*/*' }))).toEqual({
      authorization: REDACTED,
      accept: '*/*',
    })
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBeNull()
  })

  it('does not mutate its input', () => {
    const input = { authorization: 'Bearer x' }
    redact(input)
    expect(input.authorization).toBe('Bearer x')
  })
})
