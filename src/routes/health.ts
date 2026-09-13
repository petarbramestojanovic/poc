import type { FastifyPluginAsync } from 'fastify'
import type { Db } from '../db.ts'

const READY_TIMEOUT_MS = 2_000

// /healthz: the process is up. /readyz: Postgres answers SELECT 1 within 2 s.
// Sync and webhook failures never affect readiness (RFC-002 §14.1).
// Render polls both continuously, so successful probes are not logged; a failed readiness
// check is, with the pool counts that usually explain it.
export const healthRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }))

  app.get('/readyz', { logLevel: 'warn' }, async (request, reply) => {
    let timer: NodeJS.Timeout | undefined
    const ready = await Promise.race([
      db.query('SELECT 1').then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false)
        }, READY_TIMEOUT_MS)
        timer.unref()
      }),
    ])
    clearTimeout(timer)
    if (!ready) {
      request.log.warn({ pool: db.stats() }, 'readiness check failed')
      return reply.code(503).send({ status: 'unavailable' })
    }
    return { status: 'ok' }
  })
}
