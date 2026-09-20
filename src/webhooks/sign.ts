import { createHmac, timingSafeEqual } from 'node:crypto'

// RFC-002 §15.5: HMAC-SHA256 over the raw body with the webhook's own secret, sent as X-Signature
// beside X-Timestamp. The signature covers the exact bytes we put on the wire — which is why
// deliver.ts serialises the payload once and sends that string, rather than letting anything
// re-encode the object on the way out. The delivery id travels inside those bytes, so a signature
// cannot be replayed onto a different report.

export const SIGNATURE_PREFIX = 'sha256='

/** `sha256=<hex>` for the given body. */
export function signBody(body: string, secret: string): string {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

/** What a client does with the header we send; used by the tests' stub receiver. */
export function verifyBody(body: string, secret: string, header: string | undefined): boolean {
  const expected = Buffer.from(signBody(body, secret))
  const presented = Buffer.from(header ?? '')
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}
