import { describe, expect, it } from 'vitest'
import { signBody, SIGNATURE_PREFIX, verifyBody } from '../../src/webhooks/sign.ts'

const BODY = '{"version":1,"delivery_id":"9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1"}'
const SECRET = 'whsec_2f8c1e9a7b4d6f0e3a5c7b9d1f2e4a6c'

describe('webhook signing', () => {
  it('signs the exact bytes with a prefixed hex digest', () => {
    const signature = signBody(BODY, SECRET)
    expect(signature.startsWith(SIGNATURE_PREFIX)).toBe(true)
    expect(signature.slice(SIGNATURE_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/)
    expect(signBody(BODY, SECRET)).toBe(signature)
  })

  it('verifies what it signed', () => {
    expect(verifyBody(BODY, SECRET, signBody(BODY, SECRET))).toBe(true)
  })

  it('refuses a body changed by one character', () => {
    const tampered = BODY.replace('"version":1', '"version":2')
    expect(verifyBody(tampered, SECRET, signBody(BODY, SECRET))).toBe(false)
  })

  it('refuses another secret, a missing header and a truncated one', () => {
    const signature = signBody(BODY, SECRET)
    expect(verifyBody(BODY, `${SECRET}x`, signature)).toBe(false)
    expect(verifyBody(BODY, SECRET, undefined)).toBe(false)
    expect(verifyBody(BODY, SECRET, signature.slice(0, -1))).toBe(false)
  })

  it('signs multi-byte characters as UTF-8', () => {
    const body = '{"name":"Tchibo Caffè Crema"}'
    expect(verifyBody(body, SECRET, signBody(body, SECRET))).toBe(true)
  })
})
