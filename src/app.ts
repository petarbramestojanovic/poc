import { fastify, type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { requireAdminToken } from './plugins/admin-auth.ts'
import { healthRoutes } from './routes/health.ts'

export interface AppDeps {
  config: Config
  db: Db
  logger: Logger
}

export function buildApp({ config, db, logger }: AppDeps): FastifyInstance {
  const app = fastify({ loggerInstance: logger as FastifyBaseLogger })

  app.register(healthRoutes, { db })

  // Everything under /sync and /webhooks requires the operator token. Route plugins for
  // these prefixes are registered inside this scope in later steps.
  app.register(async (admin) => {
    admin.addHook('onRequest', requireAdminToken(config.adminToken))
    admin.get('/sync/*', async (_request, reply) => reply.code(404).send({ error: 'not_found' }))
    admin.get('/webhooks/*', async (_request, reply) =>
      reply.code(404).send({ error: 'not_found' }),
    )
  })

  return app
}
