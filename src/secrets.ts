// external.credential.secret_env_var is a pointer to an environment variable; this is the
// only place that dereferences it. Secret values never enter the database or the logs.

/**
 * A credential row is operator-controlled, and in phase 2 it becomes admin-UI-controlled.
 * Without a whitelist shape, a row naming DATABASE_URL or SERVICE_ADMIN_TOKEN would turn
 * one of our own secrets into a bearer token sent to a third-party host (confused deputy).
 * So a pointer must look like a third-party credential, and must not name anything the
 * service itself reads.
 */
const ALLOWED_POINTER = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_(API_KEY|KEY|TOKEN|SECRET|PASSWORD)$/
const RESERVED_POINTERS = new Set([
  'DATABASE_URL',
  'DATABASE_SSL',
  'DATABASE_SSL_CA',
  'SERVICE_ADMIN_TOKEN',
  'TZ',
  'PORT',
  'LOG_LEVEL',
])

export class MissingSecretError extends Error {
  override readonly name = 'MissingSecretError'
  readonly envVar: string
  constructor(envVar: string) {
    super(`Environment variable ${envVar} is not set`)
    this.envVar = envVar
  }
}

export class InvalidSecretPointerError extends Error {
  override readonly name = 'InvalidSecretPointerError'
  readonly envVar: string
  constructor(envVar: string, reason: string) {
    super(`Not a usable credential pointer: ${envVar} (${reason})`)
    this.envVar = envVar
  }
}

export function assertSecretPointer(envVar: string): string {
  if (RESERVED_POINTERS.has(envVar)) {
    throw new InvalidSecretPointerError(envVar, 'names a variable the service itself reads')
  }
  if (!ALLOWED_POINTER.test(envVar)) {
    throw new InvalidSecretPointerError(
      envVar,
      'must be UPPER_SNAKE_CASE ending in _API_KEY, _KEY, _TOKEN, _SECRET or _PASSWORD',
    )
  }
  return envVar
}

export function resolveSecret(envVar: string, env: NodeJS.ProcessEnv = process.env): string {
  assertSecretPointer(envVar)
  const value = env[envVar]
  if (value === undefined || value === '') throw new MissingSecretError(envVar)
  return value
}
