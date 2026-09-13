import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createDb } from './db.ts'
import { createLogger } from './log.ts'
import { createNexdConnector } from './sync/connectors/nexd/connector.ts'
import { createZeusConnector } from './sync/connectors/zeus/connector.ts'
import { createRunTracker, verifyRegistryAgainstSources } from './sync/engine.ts'
import { createRegistry } from './sync/registry.ts'

/** Render sends SIGTERM and kills the process 30 s later; finish well inside that. */
const SHUTDOWN_DEADLINE_MS = 10_000

const config = loadConfig()
const logger = createLogger(config.logLevel)
const db = createDb(config.databaseUrl, {
  logger,
  ssl: config.databaseSsl,
  sslCa: config.databaseSslCa,
})

// Process-wide cancellation. Step 9 passes `shutdown.signal` and `tracker` into runSync, so a
// deploy landing mid-run stops between day transactions and records the run as aborted.
const shutdown = new AbortController()
const tracker = createRunTracker()
export const lifecycle = { signal: shutdown.signal, tracker }

// Fail the boot, not the 04:00 run, if connectors and external.source disagree.
const registry = createRegistry([createNexdConnector(), createZeusConnector()])
await verifyRegistryAgainstSources(db, registry)

const app = buildApp({ config, db, logger, tracker, drainTimeoutMs: SHUTDOWN_DEADLINE_MS - 2_000 })

let shuttingDown = false
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')
  const hardExit = setTimeout(() => {
    logger.fatal({ deadlineMs: SHUTDOWN_DEADLINE_MS }, 'shutdown deadline exceeded; exiting')
    process.exit(1)
  }, SHUTDOWN_DEADLINE_MS)
  hardExit.unref()

  shutdown.abort(new Error(`received ${signal}`))
  try {
    await app.close() // drains in-flight runs, then closes the pool (onClose hook)
    process.exitCode = 0
  } catch (err) {
    logger.error({ err }, 'shutdown failed')
    process.exitCode = 1
  } finally {
    clearTimeout(hardExit)
  }
}
process.once('SIGTERM', (signal) => void stop(signal))
process.once('SIGINT', (signal) => void stop(signal))

await app.listen({ port: config.port, host: '0.0.0.0' })
