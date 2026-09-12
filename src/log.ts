import { pino, type Logger } from 'pino'

export type { Logger }

// Authorization headers are redacted at the logger so no call site can leak them.
const REDACTED_PATHS = [
  'req.headers.authorization',
  'res.headers.authorization',
  'headers.authorization',
  'request.headers.authorization',
  '*.authorization',
  '*.Authorization',
]

export function createLogger(level: string): Logger {
  return pino({
    name: 'analytics-be',
    level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  })
}
