import { z } from 'zod'

// Everything the service reads from the environment, validated once at boot.
// Third-party credentials are deliberately not enumerated here: external.credential rows
// name the variable that holds each secret, and src/secrets.ts resolves it at sync time.
const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  SERVICE_ADMIN_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TZ: z.literal('UTC', { error: 'must be UTC; sources and schedules carry their own timezones' }),
})

export interface Config {
  readonly databaseUrl: string
  readonly adminToken: string
  readonly port: number
  readonly logLevel: z.infer<typeof envSchema>['LOG_LEVEL']
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/** Treats empty strings as unset so `NEXD_API_KEY=` in a .env file does not count as a value. */
function withoutEmptyValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(withoutEmptyValues(env))
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  const { DATABASE_URL, SERVICE_ADMIN_TOKEN, PORT, LOG_LEVEL } = parsed.data
  return {
    databaseUrl: DATABASE_URL,
    adminToken: SERVICE_ADMIN_TOKEN,
    port: PORT,
    logLevel: LOG_LEVEL,
  }
}
