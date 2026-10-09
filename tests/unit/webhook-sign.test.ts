import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  signBody,
  signedContent,
  SIGNATURE_PREFIX,
  verifyBody,
} from '../../src/modules/webhooks/sign.ts'

const BODY = '{"version":1,"delivery_id":"9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1"}'
const SECRET = 'whsec_2f8c1e9a7b4d6f0e3a5c7b9d1f2e4a6c'
const TIMESTAMP = '1789365602'

describe('webhook signing', () => {
  it('signs the timestamp, a dot and the exact bytes, as a prefixed hex digest', () => {
    const signature = signBody(TIMESTAMP, BODY, SECRET)
    expect(signature.startsWith(SIGNATURE_PREFIX)).toBe(true)
    expect(signature.slice(SIGNATURE_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/)
    expect(signedContent(TIMESTAMP, BODY)).toBe(`${TIMESTAMP}.${BODY}`)
    // What a client computes with nothing but its HMAC library and the contract.
    const expected = createHmac('sha256', SECRET).update(`${TIMESTAMP}.${BODY}`).digest('hex')
    expect(signature).toBe(`sha256=${expected}`)
  })

  it('verifies what it signed', () => {
    expect(verifyBody(TIMESTAMP, BODY, SECRET, signBody(TIMESTAMP, BODY, SECRET))).toBe(true)
  })

  it('refuses a body changed by one character', () => {
    const tampered = BODY.replace('"version":1', '"version":2')
    expect(verifyBody(TIMESTAMP, tampered, SECRET, signBody(TIMESTAMP, BODY, SECRET))).toBe(false)
  })

  it('refuses a replay carrying a fresher timestamp', () => {
    const signature = signBody(TIMESTAMP, BODY, SECRET)
    expect(verifyBody(String(Number(TIMESTAMP) + 3600), BODY, SECRET, signature)).toBe(false)
    expect(verifyBody(undefined, BODY, SECRET, signature)).toBe(false)
  })

  it('refuses another secret, a missing header and a truncated one', () => {
    const signature = signBody(TIMESTAMP, BODY, SECRET)
    expect(verifyBody(TIMESTAMP, BODY, `${SECRET}x`, signature)).toBe(false)
    expect(verifyBody(TIMESTAMP, BODY, SECRET, undefined)).toBe(false)
    expect(verifyBody(TIMESTAMP, BODY, SECRET, signature.slice(0, -1))).toBe(false)
  })

  it('signs multi-byte characters as UTF-8', () => {
    const body = '{"name":"Tchibo Caffè Crema"}'
    expect(verifyBody(TIMESTAMP, body, SECRET, signBody(TIMESTAMP, body, SECRET))).toBe(true)
  })
})

describe('the worked example in docs/WEBHOOK-PAYLOAD-v1.md', () => {
  it('is the signature the service produces', () => {
    const body = '{"version":1,"delivery_id":"9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1"}'
    expect(signBody('1789365602', body, 'whsec_example_do_not_use')).toBe(
      'sha256=00548f589eeb06ba438d52928ab6a2ffc84e227a997aad09cd1a18ae06fbfe59',
    )
  })
})
