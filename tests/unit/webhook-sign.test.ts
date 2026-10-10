import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  signBody,
  signedContent,
  signExport,
  SIGNATURE_PREFIX,
  verifyBody,
  verifyExport,
} from '../../src/modules/webhooks/sign.ts'

const BODY = '{"version":2,"delivery_id":"9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1"}'
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
    const tampered = BODY.replace('"version":2', '"version":3')
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

describe('export link signing', () => {
  const ID = '9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1'
  const EXPIRES = 1792120202

  it('verifies what it signed', () => {
    expect(verifyExport(ID, EXPIRES, SECRET, signExport(ID, EXPIRES, SECRET))).toBe(true)
  })

  it('refuses another delivery, another expiry, another secret and a truncated signature', () => {
    const sig = signExport(ID, EXPIRES, SECRET)
    expect(verifyExport('9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d2', EXPIRES, SECRET, sig)).toBe(false)
    expect(verifyExport(ID, EXPIRES + 1, SECRET, sig)).toBe(false)
    expect(verifyExport(ID, EXPIRES, 'whsec_other', sig)).toBe(false)
    expect(verifyExport(ID, EXPIRES, SECRET, sig.slice(0, 32))).toBe(false)
  })

  it('can never stand in for a body signature, or the other way round', () => {
    // The same secret signs both; the export content starts with a label, never with digits.
    const sig = signExport(ID, EXPIRES, SECRET)
    expect(signBody(String(EXPIRES), ID, SECRET)).not.toBe(`${SIGNATURE_PREFIX}${sig}`)
  })
})

describe('the worked examples in docs/WEBHOOK-PAYLOAD-v2.md', () => {
  const secret = 'whsec_example_do_not_use'

  it('is the body signature the service produces', () => {
    const body =
      '{"version":2,"delivery_id":"9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1","generated_at":"2026-10-09T03:00:02Z","period":{"start":"2026-10-08","end":"2026-10-08","timezone":"Europe/Zurich","frequency":"daily"},"rows":[{"Date":"2026-10-08","Campaign":"DE2610 Tchibo Caffè Crema","Impressions":120345,"Cost":1875.99}]}'
    expect(signBody('1791515402', body, secret)).toBe(
      'sha256=cdb1da1b5aa4352d5729797abf27efd654fe4a92b1c1be5891fbfbf3cac87989',
    )
  })

  it('is the export link signature the service produces', () => {
    expect(signExport('9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1', 1792120202, secret)).toBe(
      '6d5013fe6afd8aa85332d69a3343fdd659492c58eaff6daf61f43e57f686f15b',
    )
  })
})
