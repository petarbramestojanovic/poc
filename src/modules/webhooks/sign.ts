import { createHmac, timingSafeEqual } from 'node:crypto'

// RFC-002 §15.5: HMAC-SHA256 with the webhook's own secret, sent as X-Signature. What it covers is
// the X-Timestamp value, a dot, and the raw body (the phase 1 plan's `timestamp + "." + rawBody`):
//
//   * the exact bytes we put on the wire — which is why deliver.ts serialises the payload once and
//     sends that string, rather than letting anything re-encode the object on the way out;
//   * the delivery id, which travels inside those bytes, so a signature cannot be replayed onto a
//     different report;
//   * the timestamp, so a client that rejects old timestamps is rejecting something an attacker
//     cannot rewrite. Unsigned, the header could be set to anything on a replayed request.

export const SIGNATURE_PREFIX = 'sha256='

/** Exactly what the signature covers. */
export function signedContent(timestamp: string, body: string): string {
  return `${timestamp}.${body}`
}

/** `sha256=<hex>` for the given timestamp and body. */
export function signBody(timestamp: string, body: string, secret: string): string {
  return (
    SIGNATURE_PREFIX +
    createHmac('sha256', secret).update(signedContent(timestamp, body), 'utf8').digest('hex')
  )
}

/**
 * The signature of a CSV export link (exports.ts): the delivery id and the link's expiry, under the
 * webhook's own secret. The content starts with a fixed label, never with the digits a body
 * signature starts with, so neither signature can ever stand in for the other.
 */
export function signExport(deliveryId: string, expires: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`export.${deliveryId}.${String(expires)}`, 'utf8')
    .digest('hex')
}

export function verifyExport(
  deliveryId: string,
  expires: number,
  secret: string,
  presented: string,
): boolean {
  const expected = Buffer.from(signExport(deliveryId, expires, secret))
  const given = Buffer.from(presented)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** What a client does with the headers we send; used by the tests' stub receiver. */
export function verifyBody(
  timestamp: string | undefined,
  body: string,
  secret: string,
  header: string | undefined,
): boolean {
  if (timestamp === undefined) return false
  const expected = Buffer.from(signBody(timestamp, body, secret))
  const presented = Buffer.from(header ?? '')
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}
