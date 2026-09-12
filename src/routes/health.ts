import type { FastifyPluginAsync } from 'fastify'
import type { Db } from '../db.ts'

const READY_TIMEOUT_MS = 2_000

// /healthz: the process is up. /readyz: Postgres answers SELECT 1 within 2 s.
// Sync and webhook failures never affect readiness (RFC-002 §14.1).
export const healthRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/readyz', async (_request, reply) => {
    const ready = await Promise.race([
      db.query('SELECT 1').then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolve(false)
        }, READY_TIMEOUT_MS).unref(),
      ),
    ])
    if (!ready) return reply.code(503).send({ status: 'unavailable' })
    return { status: 'ok' }
  })
}
