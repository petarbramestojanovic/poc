import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

// Phase 1 operator auth: a single shared bearer token on /sync and /webhooks.
// Phase 2 swaps this hook for Supabase user tokens with company scoping; nothing else changes.

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

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
  return async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!tokenMatches(bearerToken(request.headers.authorization), expected)) {
      await reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' })
    }
  }
}
