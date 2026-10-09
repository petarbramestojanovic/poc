// Strips credentials from anything that is logged or persisted (raw_payload.request, and
// sync_run.error). Applied by value: the input is never mutated.

const SECRET_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|passwd|private[-_]?key|signature|x-signature|sig)$/i
const BEARER_IN_TEXT = /(bearer\s+)[^\s"']+/gi

export const REDACTED = '[REDACTED]'

/** Blanks credential-looking query parameters, leaving the rest of the URL readable. */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  let changed = false
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_KEY.test(key)) {
      parsed.searchParams.set(key, REDACTED)
      changed = true
    }
  }
  return changed ? parsed.toString() : url
}

export function redact<T>(value: T): T {
  return redactAny(value) as T
}

function redactString(value: string): string {
  const withoutQuerySecrets = redactUrl(value)
  return withoutQuerySecrets.replace(BEARER_IN_TEXT, `$1${REDACTED}`)
}

function redactAny(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactAny)
  if (value instanceof Headers) return redactAny(Object.fromEntries(value.entries()))
  if (value !== null && typeof value === 'object') {
    // A null prototype so a `__proto__` key in third-party JSON becomes an own property
    // here rather than silently setting the prototype of the output object.
    const out = Object.create(null) as Record<string, unknown>
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactAny(inner)
    }
    return { ...out }
  }
  return value
}
