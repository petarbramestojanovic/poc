import { z } from 'zod'
import { formatSender, isEmailAddress, parseSender } from './mail/address.ts'
import { MAIL_PROVIDER_NAMES, type MailConfig } from './mail/types.ts'

// Everything the service reads from the environment, validated once at boot. The operator CLI
// reads only the runtime subset (database and logging), so running a sync never needs the admin
// token. Third-party credentials are deliberately not enumerated here: external.credential rows
// name the variable that holds each secret, and src/core/secrets.ts resolves it at sync time.

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
  /**
   * The NEXD folder that provisioning creates campaigns in (CLAUDE.md, Provisioning). Unset: the
   * account root. On staging a test folder, until the flow is proven.
   */
  NEXD_PROVISION_FOLDER_ID: z.string().trim().min(1).max(64).optional(),
  /**
   * OpenRouter's API key: the LLM that classifies a campaign's industry when the keyword table
   * knows no brand (CLAUDE.md, Industries). Unset = the keyword table only. Read by the service
   * and by `npm run industries`.
   */
  OPENROUTER_API_KEY: z
    .string()
    .trim()
    .min(20, 'must be an OpenRouter API key (at least 20 characters)')
    .optional(),
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

/**
 * Email (src/core/mail). Unset MAIL_PROVIDER = email is off and the other three are not read. Set,
 * it needs a sender and the provider's key, so a half-configured service fails at boot rather than
 * at 03:00.
 */
const mailFields = {
  MAIL_PROVIDER: z.enum(MAIL_PROVIDER_NAMES).optional(),
  /** Resend → API Keys, permission "Sending access", limited to the sender's domain. */
  RESEND_API_KEY: z
    .string()
    .regex(/^re_[A-Za-z0-9_-]+$/, 'must be a Resend API key (starts with re_)')
    .optional(),
  /** "Klea Analytics <reports@example.com>" or "reports@example.com", on a domain Resend verified. */
  MAIL_FROM: z
    .string()
    .refine((value) => parseSender(value) !== undefined, {
      error:
        'must be "address" or "Name <address>", with no quotes, commas or angle brackets in the name',
    })
    .transform((value) => formatSender(parseSender(value) ?? { address: value }))
    .optional(),
  /** Where a reply goes when the sender is not a mailbox. Optional. */
  MAIL_REPLY_TO: z
    .string()
    .refine(isEmailAddress, { error: 'must be one email address' })
    .optional(),
}

function checkMail(
  env: {
    MAIL_PROVIDER?: string | undefined
    MAIL_FROM?: string | undefined
    RESEND_API_KEY?: string | undefined
  },
  ctx: z.RefinementCtx,
): void {
  if (env.MAIL_PROVIDER === undefined) return
  if (env.MAIL_FROM === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_FROM'],
      message: 'is required when MAIL_PROVIDER is set',
    })
  }
  if (env.MAIL_PROVIDER === 'resend' && env.RESEND_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESEND_API_KEY'],
      message: 'is required when MAIL_PROVIDER is resend',
    })
  }
}

const mailSchema = z.object(mailFields).superRefine(checkMail)

type MailEnv = z.infer<typeof mailSchema>

function toMailConfig(env: MailEnv): MailConfig | undefined {
  if (env.MAIL_PROVIDER === undefined || env.MAIL_FROM === undefined) return undefined
  const sender = {
    from: env.MAIL_FROM,
    ...(env.MAIL_REPLY_TO === undefined ? {} : { replyTo: env.MAIL_REPLY_TO }),
  }
  switch (env.MAIL_PROVIDER) {
    case 'resend':
      if (env.RESEND_API_KEY === undefined) return undefined
      return { provider: { name: 'resend', apiKey: env.RESEND_API_KEY }, ...sender }
    case 'memory':
      return { provider: { name: 'memory' }, ...sender }
  }
}

/** An origin the internet can reach: https, or http on a loopback host for local runs. */
const publicBaseUrl = z
  .url({ protocol: /^https?$/ })
  .refine(
    (value) => {
      const url = new URL(value)
      return url.protocol === 'https:' || LOOPBACK_HOSTS.has(url.hostname)
    },
    { error: 'must be https (http only for a loopback host)' },
  )
  .refine(
    (value) => {
      const url = new URL(value)
      return url.pathname === '/' && url.search === '' && url.hash === ''
    },
    { error: 'must be an origin only, such as https://analytics.example.com' },
  )
  .transform((value) => new URL(value).origin)

const serviceSchema = z
  .object({
    ...runtimeFields,
    ...mailFields,
    SERVICE_ADMIN_TOKEN: z
      .string()
      .min(32, 'must be at least 32 characters (generate with: openssl rand -base64 32)'),
    /**
     * The bearer token of POST /inbound/salesforce/opportunities, Salesforce's webhook of committed
     * opportunities. Its own token, so the sender can never reach an admin route. Unset = no
     * /inbound route.
     */
    INBOUND_CAMPAIGNS_TOKEN: z
      .string()
      .min(32, 'must be at least 32 characters (generate with: openssl rand -base64 32)')
      .optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Number of reverse proxies in front of the service (Render = 1, Cloudflare + Render = 2). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    /** Schedules the 00:30 UTC nightly pass in this process. Every replica may; the leader lock picks one. */
    SYNC_SCHEDULER_ENABLED: z.stringbool().default(true),
    /** Runs the minutely webhook tick in this process. Same leader-lock rule as the nightly pass. */
    WEBHOOK_SCHEDULER_ENABLED: z.stringbool().default(true),
    /**
     * Runs the minutely email report tick in this process, when email is on (MAIL_PROVIDER). Same
     * leader-lock rule as the webhook tick.
     */
    EMAIL_REPORT_SCHEDULER_ENABLED: z.stringbool().default(true),
    /**
     * Provisions every campaign the Salesforce push creates, in the background (CLAUDE.md,
     * Provisioning). Off by default: on staging it creates real NEXD campaigns, so it is turned on
     * once the flow is proven against the test folder.
     */
    PROVISIONING_ENABLED: z.stringbool().default(false),
    /**
     * Where this service is reachable from the internet, e.g. https://analytics.example.com: a csv
     * webhook links its file there (/exports/…). Unset, Render's RENDER_EXTERNAL_URL is used.
     */
    PUBLIC_BASE_URL: publicBaseUrl.optional(),
    /**
     * Set by Render to the service's onrender.com address; the fallback for PUBLIC_BASE_URL. Not
     * ours to set, so a value that is not a usable origin is ignored rather than failing the boot.
     */
    RENDER_EXTERNAL_URL: publicBaseUrl.optional().catch(undefined),
    /** Set by Render to the deployed commit. /healthz reports it so a deploy can see it is live. */
    RENDER_GIT_COMMIT: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/, 'must be a git commit SHA')
      .optional(),
  })
  .superRefine(checkDatabase)
  .superRefine(checkMail)
  .superRefine((env, ctx) => {
    if (env.INBOUND_CAMPAIGNS_TOKEN === env.SERVICE_ADMIN_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['INBOUND_CAMPAIGNS_TOKEN'],
        message: 'must differ from SERVICE_ADMIN_TOKEN, or the sender could call the admin routes',
      })
    }
  })

export type LogLevel = z.infer<typeof runtimeSchema>['LOG_LEVEL']

/** What the sync machinery needs: the service and the operator CLI both load it. */
export interface RuntimeConfig {
  readonly databaseUrl: string
  readonly databaseSsl: 'disable' | 'verify-full'
  readonly databaseSslCa: string | undefined
  readonly logLevel: LogLevel
  /** Where provisioning creates NEXD campaigns; unset = the account root. */
  readonly nexdProvisionFolderId?: string
  /** The industry LLM's key (OpenRouter); unset = unknown brands stay unclassified. */
  readonly openRouterApiKey?: string
}

export interface Config extends RuntimeConfig {
  readonly adminToken: string
  /** Unset: POST /inbound/salesforce/opportunities does not exist. */
  readonly inboundCampaignsToken?: string
  readonly port: number
  readonly trustProxyHops: number
  readonly syncSchedulerEnabled: boolean
  readonly webhookSchedulerEnabled: boolean
  /** The email report tick; it runs only when `mail` is set too. */
  readonly emailReportSchedulerEnabled: boolean
  /** Set (true) when the Salesforce push provisions the campaigns it creates; unset = no. */
  readonly provisioningEnabled?: boolean
  /** The origin a csv webhook's links point at; unset, no csv webhook can be set up. */
  readonly publicBaseUrl?: string
  /** The deployed commit, when the host tells us (Render does). */
  readonly commit?: string
  /** Unset: email is off (MAIL_PROVIDER is not set). */
  readonly mail?: MailConfig
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
    ...withNexdFolder(data.NEXD_PROVISION_FOLDER_ID),
    ...withOpenRouterKey(data.OPENROUTER_API_KEY),
  }
}

/** The mail settings alone, for `npm run mail`; undefined when MAIL_PROVIDER is not set. */
export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | undefined {
  return toMailConfig(parse(mailSchema, env))
}

function withNexdFolder(value: string | undefined): { nexdProvisionFolderId?: string } {
  return value === undefined ? {} : { nexdProvisionFolderId: value }
}

function withOpenRouterKey(value: string | undefined): { openRouterApiKey?: string } {
  return value === undefined ? {} : { openRouterApiKey: value }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const data = parse(serviceSchema, env)
  const mail = toMailConfig(data)
  return {
    databaseUrl: data.DATABASE_URL,
    databaseSsl: data.DATABASE_SSL,
    databaseSslCa: data.DATABASE_SSL_CA,
    adminToken: data.SERVICE_ADMIN_TOKEN,
    ...(data.INBOUND_CAMPAIGNS_TOKEN === undefined
      ? {}
      : { inboundCampaignsToken: data.INBOUND_CAMPAIGNS_TOKEN }),
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    ...withNexdFolder(data.NEXD_PROVISION_FOLDER_ID),
    ...withOpenRouterKey(data.OPENROUTER_API_KEY),
    trustProxyHops: data.TRUST_PROXY_HOPS,
    syncSchedulerEnabled: data.SYNC_SCHEDULER_ENABLED,
    webhookSchedulerEnabled: data.WEBHOOK_SCHEDULER_ENABLED,
    emailReportSchedulerEnabled: data.EMAIL_REPORT_SCHEDULER_ENABLED,
    ...(data.PROVISIONING_ENABLED ? { provisioningEnabled: true } : {}),
    ...withPublicBaseUrl(data.PUBLIC_BASE_URL ?? data.RENDER_EXTERNAL_URL),
    ...(data.RENDER_GIT_COMMIT === undefined ? {} : { commit: data.RENDER_GIT_COMMIT }),
    ...(mail === undefined ? {} : { mail }),
  }
}

function withPublicBaseUrl(value: string | undefined): { publicBaseUrl?: string } {
  return value === undefined ? {} : { publicBaseUrl: value }
}
