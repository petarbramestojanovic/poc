import { buildApp } from './app.ts'
import type { CampaignDeps } from './campaigns/service.ts'
import { loadConfig } from './config.ts'
import { createLogger } from './log.ts'
import { createSyncRuntime, createWebhookHttpClient } from './runtime.ts'
import { createRunTracker, type SyncDeps } from './sync/engine.ts'
import { startNightlyScheduler, type NightlyScheduler } from './sync/scheduler.ts'
import { startWebhookScheduler, type WebhookScheduler } from './webhooks/scheduler.ts'
import type { SendDeps } from './webhooks/send.ts'

/** Render sends SIGTERM and kills the process 30 s later; finish well inside that. */
const SHUTDOWN_DEADLINE_MS = 10_000

const config = loadConfig()
const logger = createLogger(config.logLevel)
// Pool, HTTP client, connectors and the sync pool share. Fails the boot if the connector registry
// and external.source disagree.
const runtime = await createSyncRuntime(config, logger)

// Process-wide cancellation: a deploy landing mid-run stops it between day transactions and the
// run is recorded as aborted. The tracker lets app.close() wait for in-flight runs.
const shutdown = new AbortController()
const tracker = createRunTracker()

// One set of sync dependencies for the trigger route and the nightly scheduler.
const sync: SyncDeps = {
  db: runtime.db,
  registry: runtime.registry,
  http: runtime.http,
  log: logger,
  limiter: runtime.limiter,
  signal: shutdown.signal,
  tracker,
}

// Webhook delivery shares the pool and the tracker, and gets its own HTTP client: one attempt,
// 10 s, no in-process retry. The tracker lets app.close() wait for a send-now delivery in flight.
const webhooks: SendDeps = {
  db: runtime.db,
  http: createWebhookHttpClient(logger),
  log: logger,
  signal: shutdown.signal,
  tracker,
}

// Campaign setup validates against the same connectors the sync engine runs.
const campaigns: CampaignDeps = { db: runtime.db, registry: runtime.registry, log: logger }

const app = buildApp({
  config,
  db: runtime.db,
  logger,
  tracker,
  sync,
  webhooks,
  campaigns,
  drainTimeoutMs: SHUTDOWN_DEADLINE_MS - 2_000,
})

let scheduler: NightlyScheduler | undefined
let webhookScheduler: WebhookScheduler | undefined
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
    // No new ticks. A pass already running stops before its next day and releases the lock.
    await Promise.all([scheduler?.stop(), webhookScheduler?.stop()])
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

if (!config.syncSchedulerEnabled) {
  logger.info('nightly sync scheduler disabled (SYNC_SCHEDULER_ENABLED=false)')
} else if (!shutdown.signal.aborted) {
  // A signal can land while listen() is still pending; never start ticks after that.
  scheduler = startNightlyScheduler(sync)
}

if (!config.webhookSchedulerEnabled) {
  logger.info('webhook scheduler disabled (WEBHOOK_SCHEDULER_ENABLED=false)')
} else if (!shutdown.signal.aborted) {
  webhookScheduler = startWebhookScheduler(webhooks)
}
