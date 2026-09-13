import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createLogger } from './log.ts'
import { createSyncRuntime } from './runtime.ts'
import { createRunTracker } from './sync/engine.ts'

/** Render sends SIGTERM and kills the process 30 s later; finish well inside that. */
const SHUTDOWN_DEADLINE_MS = 10_000

const config = loadConfig()
const logger = createLogger(config.logLevel)
// Pool, HTTP client, connectors and the sync pool share. Fails the boot if the connector registry
// and external.source disagree.
const runtime = await createSyncRuntime(config, logger)

// Process-wide cancellation. Step 9 passes `shutdown.signal` and `tracker` into runSync, so a
// deploy landing mid-run stops between day transactions and records the run as aborted.
const shutdown = new AbortController()
const tracker = createRunTracker()
export const lifecycle = { signal: shutdown.signal, tracker, runtime }

const app = buildApp({
  config,
  db: runtime.db,
  logger,
  tracker,
  drainTimeoutMs: SHUTDOWN_DEADLINE_MS - 2_000,
})

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
