import { z } from 'zod'

// Everything the service reads from the environment, validated once at boot. The operator CLI
// reads only the runtime subset (database and logging), so running a sync never needs the admin
// token. Third-party credentials are deliberately not enumerated here: external.credential rows
// name the variable that holds each secret, and src/secrets.ts resolves it at sync time.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Supavisor's transaction-mode port. Session-level advisory locks (leader election) break there. */
const TRANSACTION_POOLER_PORT = '6543'

const runtimeFields = {
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** verify-full = TLS with certificate verification. disable is only accepted for a loopback host. */
  DATABASE_SSL: z.enum(['disable', 'verify-full']).default('verify-full'),
  /** PEM of the CA that signs the database certificate (Supabase: dashboard → Database → SSL). */
  DATABASE_SSL_CA: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TZ: z.literal('UTC', { error: 'must be UTC; sources and schedules carry their own timezones' }),
}

function checkDatabase(
  env: { DATABASE_URL: string; DATABASE_SSL: 'disable' | 'verify-full' },
  ctx: z.RefinementCtx,
): void {
  const url = new URL(env.DATABASE_URL)
  if (env.DATABASE_SSL === 'disable' && !LOOPBACK_HOSTS.has(url.hostname)) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_SSL'],
      message: `disable is only allowed for a loopback host, not ${url.hostname}`,
    })
  }
  if (url.port === TRANSACTION_POOLER_PORT) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message:
        'port 6543 is the transaction-mode pooler; the leader lock needs a session (port 5432 session pooler or direct connection)',
    })
  }
}

const runtimeSchema = z.object(runtimeFields).superRefine(checkDatabase)

const serviceSchema = z
  .object({
    ...runtimeFields,
    SERVICE_ADMIN_TOKEN: z
      .string()
      .min(32, 'must be at least 32 characters (generate with: openssl rand -base64 32)'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Number of reverse proxies in front of the service (Render = 1, Cloudflare + Render = 2). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    /** Schedules the 04:00 nightly pass in this process. Every replica may; the leader lock picks one. */
    SYNC_SCHEDULER_ENABLED: z.stringbool().default(true),
    /** Runs the minutely webhook tick in this process. Same leader-lock rule as the nightly pass. */
    WEBHOOK_SCHEDULER_ENABLED: z.stringbool().default(true),
  })
  .superRefine(checkDatabase)

export type LogLevel = z.infer<typeof runtimeSchema>['LOG_LEVEL']

/** What the sync machinery needs: the service and the operator CLI both load it. */
export interface RuntimeConfig {
  readonly databaseUrl: string
  readonly databaseSsl: 'disable' | 'verify-full'
  readonly databaseSslCa: string | undefined
  readonly logLevel: LogLevel
}

export interface Config extends RuntimeConfig {
  readonly adminToken: string
  readonly port: number
  readonly trustProxyHops: number
  readonly syncSchedulerEnabled: boolean
  readonly webhookSchedulerEnabled: boolean
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

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(withoutEmptyValues(env))
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const data = parse(runtimeSchema, env)
  return {
    databaseUrl: data.DATABASE_URL,
    databaseSsl: data.DATABASE_SSL,
    databaseSslCa: data.DATABASE_SSL_CA,
    logLevel: data.LOG_LEVEL,
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const data = parse(serviceSchema, env)
  return {
    databaseUrl: data.DATABASE_URL,
    databaseSsl: data.DATABASE_SSL,
    databaseSslCa: data.DATABASE_SSL_CA,
    adminToken: data.SERVICE_ADMIN_TOKEN,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    trustProxyHops: data.TRUST_PROXY_HOPS,
    syncSchedulerEnabled: data.SYNC_SCHEDULER_ENABLED,
    webhookSchedulerEnabled: data.WEBHOOK_SCHEDULER_ENABLED,
  }
}
