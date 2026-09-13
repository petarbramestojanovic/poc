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
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { requireAdminToken } from './plugins/admin-auth.ts'
import { healthRoutes } from './routes/health.ts'
import { syncRoutes } from './routes/sync.ts'
import type { RunTracker, SyncDeps } from './sync/engine.ts'
import {
  classifySyncError,
  InvalidLinkConfigError,
  SyncError,
  TooSoonError,
} from './sync/errors.ts'

export interface AppDeps {
  config: Config
  db: Db
  logger: Logger
  /** In-flight sync runs; `app.close()` waits for them (up to the drain timeout) before closing the pool. */
  tracker?: RunTracker
  drainTimeoutMs?: number
  /** Sync machinery behind the /sync routes. The service passes it; without it /sync answers 404. */
  sync?: SyncDeps
}

/** Admin prefixes: every method and path under these requires the operator token. */
export const ADMIN_PREFIXES = ['/sync', '/webhooks'] as const

export function buildApp({
  config,
  db,
  logger,
  tracker,
  drainTimeoutMs = 8_000,
  sync,
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

  app.register(healthRoutes, { db })

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
      },
      { prefix },
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
  if (error instanceof SyncError && error.status < 500) {
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
