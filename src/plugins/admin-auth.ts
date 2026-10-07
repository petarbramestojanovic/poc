import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

// Phase 1 operator auth: a single shared bearer token on the admin prefixes, and a second one of
// its own on /inbound, where another of our apps pushes the daily Salesforce report.
// Phase 2 swaps the admin hook for Supabase user tokens with company scoping; nothing else changes.
// Rate limiting needs @fastify/rate-limit, which is outside the fixed stack (plan: ask first).

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Constant-time over SHA-256 digests: no timing leak and no length leak. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false
  return timingSafeEqual(digest(presented), digest(expected))
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const [scheme, token, ...rest] = header.trim().split(/\s+/)
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || rest.length > 0) return undefined
  return token
}

export function requireAdminToken(expected: string) {
  return requireBearerToken(expected, 'admin')
}

/** `scope` names the token in the refusal log line, e.g. 'inbound auth rejected'. */
export function requireBearerToken(expected: string, scope: string) {
  return async function bearerAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization
    const token = bearerToken(header)
    if (tokenMatches(token, expected)) return
    // Never log the presented value — only why it was refused, where, and from whom.
    request.log.warn(
      {
        reason: header === undefined ? 'missing' : token === undefined ? 'malformed' : 'mismatch',
        path: request.url.split('?')[0],
        method: request.method,
        ip: request.ip,
      },
      `${scope} auth rejected`,
    )
    await reply
      .code(401)
      .header('www-authenticate', 'Bearer')
      .header('cache-control', 'no-store')
      .send({ error: 'unauthorized' })
  }
}
