import { pino, type DestinationStream, type Logger } from 'pino'

export type { Logger }

/**
 * Redaction is by EXPLICIT PATH, not by wildcard: pino's `*` matches exactly one level, so a
 * nested object would slip through. Anything logged from an unknown shape must be passed
 * through `redact()` (src/core/http/redact.ts) by its call site first — this list only covers the
 * objects this codebase actually carries into a log call.
 */
const REDACTED_PATHS = [
  // Fastify request/response logging.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Objects this code logs directly.
  'headers.authorization',
  'headers.cookie',
  'request.headers.authorization',
  'credential.secret',
  'config.databaseUrl',
  'config.databaseSslCa',
  'config.adminToken',
  'webhook.secret',
  'delivery.secret',
  // Bare properties.
  'authorization',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'password',
  'databaseUrl',
  'adminToken',
]

export const redactedLogPaths: readonly string[] = REDACTED_PATHS

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    name: 'analytics-be',
    level,
    redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
  }
  return destination ? pino(options, destination) : pino(options)
}
