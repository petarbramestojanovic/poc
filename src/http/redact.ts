// Strips credentials from anything that is logged or persisted (raw_payload.request).
// Applied by value: the input is never mutated.

const SECRET_KEY =
  /^(authorization|proxy-authorization|x-api-key|api[-_]?key|token|access[-_]?token|secret|password)$/i
const BEARER_IN_TEXT = /(bearer\s+)[^\s"']+/gi

export const REDACTED = '[REDACTED]'

export function redact<T>(value: T): T {
  return redactAny(value) as T
}

function redactAny(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(BEARER_IN_TEXT, `$1${REDACTED}`)
  if (Array.isArray(value)) return value.map(redactAny)
  if (value instanceof Headers) return redactAny(Object.fromEntries(value.entries()))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactAny(inner)
    }
    return out
  }
  return value
}
