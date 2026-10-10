import { randomUUID } from 'node:crypto'
import {
  fastify,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import type { ZodType } from 'zod'
import type { Config } from './core/config.ts'
import type { Db } from './core/db.ts'
import type { CampaignDeps } from './modules/campaigns/service.ts'
import { AppError } from './core/errors.ts'
import type { Logger } from './core/log.ts'
import { requireAdminToken, requireBearerToken } from './core/plugins/admin-auth.ts'
import { campaignRoutes } from './modules/campaigns/routes.ts'
import { companyRoutes } from './modules/companies/routes.ts'
import { healthRoutes } from './modules/health/routes.ts'
import { inboundRoutes } from './modules/salesforce/routes.ts'
import { syncRoutes } from './modules/sync/routes.ts'
import { EXPORT_PREFIX } from './modules/webhooks/exports.ts'
import { exportRoutes, webhookRoutes } from './modules/webhooks/routes.ts'
import type { RunTracker, SyncDeps } from './modules/sync/engine.ts'
import { classifySyncError, InvalidLinkConfigError, TooSoonError } from './modules/sync/errors.ts'
import type { SendDeps } from './modules/webhooks/send.ts'

export interface AppDeps {
  config: Config
  db: Db
  logger: Logger
  /** In-flight sync runs; `app.close()` waits for them (up to the drain timeout) before closing the pool. */
  tracker?: RunTracker
  drainTimeoutMs?: number
  /** Sync machinery behind the /sync routes. The service passes it; without it /sync answers 404. */
  sync?: SyncDeps
  /** Webhook machinery behind the /webhooks and /exports routes. Without it both answer 404. */
  webhooks?: SendDeps
  /**
   * Campaign setup behind /companies, /campaigns and (with config.inboundCampaignsToken)
   * /inbound/campaigns. Without it they answer 404.
   */
  campaigns?: CampaignDeps
}

/** Admin prefixes: every method and path under these requires the operator token. */
export const ADMIN_PREFIXES = ['/sync', '/webhooks', '/companies', '/campaigns'] as const

/** Where other systems push to us, behind config.inboundCampaignsToken. Never an admin route. */
export const INBOUND_PREFIX = '/inbound'

export function buildApp({
  config,
  db,
  logger,
  tracker,
  drainTimeoutMs = 8_000,
  sync,
  webhooks,
  campaigns,
}: AppDeps): FastifyInstance {
  // Widen to Fastify's logger interface so its logger type parameter is not inferred as the
  // concrete pino type, which conflicts with Fastify's own child-logger factory typing.
  const loggerInstance: FastifyBaseLogger = logger
  const app = fastify({
    loggerInstance,
    // Render (and Cloudflare, if chained) sit in front: a hop count, never `true`, so a client
    // cannot spoof its address with its own X-Forwarded-For.
    trustProxy:
      config.trustProxyHops > 0
        ? (_address: string, hop: number) => hop < config.trustProxyHops
        : false,
    // Unique across the 2–4 replicas; the default is a per-process counter.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    // Admin routes take small JSON objects; raise per route only where needed.
    bodyLimit: 64 * 1024,
  })

  // Route schemas are zod (plan: zod for request bodies). Wired once, at the root.
  app.setValidatorCompiler<ZodType>(({ schema }) => (data: unknown) => {
    const result = schema.safeParse(data)
    return result.success ? { value: result.data } : { error: result.error }
  })
  app.setSerializerCompiler<ZodType>(
    ({ schema }) =>
      (data: unknown) =>
        JSON.stringify(schema.parse(data)),
  )

  app.setErrorHandler(rootErrorHandler)
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }))

  // The pool is part of the app lifecycle: app.close() is the single drain path for signals,
  // tests and the CLI alike — first in-flight runs, then connections.
  app.addHook('onClose', async () => {
    if (tracker && tracker.size > 0) {
      const drained = await tracker.drain(drainTimeoutMs)
      if (!drained) logger.error({ runs: tracker.size }, 'sync runs still in flight at shutdown')
    }
    await db.close()
  })

  app.register(healthRoutes, { db, commit: config.commit })

  // Each admin prefix is its own encapsulated scope whose auth hook is registered BEFORE its
  // not-found handler, so an unknown method or path under the prefix is authenticated first
  // and never answered by the unauthenticated root 404. Route plugins register in these scopes.
  for (const prefix of ADMIN_PREFIXES) {
    app.register(
      async (admin) => {
        admin.addHook('onRequest', requireAdminToken(config.adminToken))
        admin.setNotFoundHandler(async (_request, reply) =>
          reply.code(404).send({ error: 'not_found' }),
        )
        if (prefix === '/sync' && sync) await admin.register(syncRoutes, { deps: sync })
        if (prefix === '/webhooks' && webhooks) {
          await admin.register(webhookRoutes, { deps: webhooks })
        }
        if (prefix === '/companies' && campaigns) {
          await admin.register(companyRoutes, { deps: { db: campaigns.db } })
        }
        if (prefix === '/campaigns' && campaigns) {
          await admin.register(campaignRoutes, { deps: campaigns })
        }
      },
      { prefix },
    )
  }

  // Public on purpose: a client's importer (Funnel) fetches a csv webhook's file here, and the signed
  // link is the only key (src/modules/webhooks/exports.ts). It reaches that file and nothing else.
  if (webhooks) {
    app.register(
      async (exports) => {
        exports.setNotFoundHandler(async (_request, reply) =>
          reply.code(404).send({ error: 'not_found' }),
        )
        await exports.register(exportRoutes, { deps: webhooks })
      },
      { prefix: EXPORT_PREFIX },
    )
  }

  // The same shape as an admin scope, with its own token: the sending app can push the report and
  // reach nothing else. Without a token there is no /inbound scope, and the root answers 404.
  const inboundToken = config.inboundCampaignsToken
  if (inboundToken !== undefined && campaigns) {
    app.register(
      async (inbound) => {
        inbound.addHook('onRequest', requireBearerToken(inboundToken, 'inbound'))
        inbound.setNotFoundHandler(async (_request, reply) =>
          reply.code(404).send({ error: 'not_found' }),
        )
        await inbound.register(inboundRoutes, { deps: campaigns })
      },
      { prefix: INBOUND_PREFIX },
    )
  }

  return app
}

async function rootErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (error instanceof InvalidLinkConfigError) {
    // Field paths and messages only; never the config values.
    return reply.code(422).send({ error: error.code, issues: error.issues })
  }
  if (error instanceof AppError && error.status < 500) {
    if (error instanceof TooSoonError) reply.header('retry-after', String(error.retryAfterSeconds))
    return reply.code(error.status).send({ error: error.code, message: error.message })
  }
  const statusCode = error.statusCode
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    // Fastify's own client errors: validation, malformed JSON, body too large.
    return reply.code(statusCode).send({
      error: error.code || 'bad_request',
      message: error.message,
    })
  }
  // Everything else: log it in full, answer with a fixed body. Upstream excerpts, env var names
  // and raw Postgres errors never reach the response.
  const { code, status } = classifySyncError(error)
  request.log.error({ err: error, code }, 'request failed')
  return reply.code(status).send({ error: code === 'internal' ? 'internal_error' : code })
}
