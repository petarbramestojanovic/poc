import { buildApp } from './app.ts'
import type { CampaignDeps } from './modules/campaigns/service.ts'
import { loadConfig } from './core/config.ts'
import { createLogger } from './core/log.ts'
import { createHttpClient } from './core/http/HttpClient.ts'
import { createMailer } from './core/mail/mailer.ts'
import { createMailHttpClient, createSyncRuntime, createWebhookHttpClient } from './runtime.ts'
import {
  startEmailReportScheduler,
  type EmailReportScheduler,
} from './modules/email-reports/scheduler.ts'
import type { EmailReportServiceDeps } from './modules/email-reports/send.ts'
import type { ProvisioningDeps } from './modules/provisioning/service.ts'
import { createRunTracker, type SyncDeps } from './modules/sync/engine.ts'
import { startNightlyScheduler, type NightlyScheduler } from './modules/sync/scheduler.ts'
import { startWebhookScheduler, type WebhookScheduler } from './modules/webhooks/scheduler.ts'
import type { SendDeps } from './modules/webhooks/send.ts'

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
// The public base URL is where a csv webhook's links point.
const webhooks: SendDeps = {
  db: runtime.db,
  http: createWebhookHttpClient(logger),
  log: logger,
  exportBaseUrl: config.publicBaseUrl,
  signal: shutdown.signal,
  tracker,
}

// Campaign setup validates against the same connectors the sync engine runs.
const campaigns: CampaignDeps = { db: runtime.db, registry: runtime.registry, log: logger }

// Email reports share the pool and the tracker. The mailer exists only while email is on
// (MAIL_PROVIDER); without it reports can be listed, changed and previewed, not created or sent.
const mailer =
  config.mail === undefined
    ? undefined
    : createMailer(config.mail, { http: createMailHttpClient(logger) })
const emailReports: EmailReportServiceDeps = {
  db: runtime.db,
  mailer,
  log: logger,
  signal: shutdown.signal,
  tracker,
}

// Provisioning creates campaigns and creatives on the platforms through the same connectors, with
// the sync's retrying client and a second one without retries for polling (NEXD says 408 for
// "still importing").
const provisioning: ProvisioningDeps = {
  db: runtime.db,
  registry: runtime.registry,
  http: runtime.http,
  httpNoRetry: createHttpClient({ log: logger, maxRetries: 0 }),
  log: logger,
  campaigns,
  signal: shutdown.signal,
}

const app = buildApp({
  config,
  db: runtime.db,
  logger,
  tracker,
  sync,
  webhooks,
  campaigns,
  emailReports,
  provisioning,
  drainTimeoutMs: SHUTDOWN_DEADLINE_MS - 2_000,
})

let scheduler: NightlyScheduler | undefined
let webhookScheduler: WebhookScheduler | undefined
let emailReportScheduler: EmailReportScheduler | undefined
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
    await Promise.all([scheduler?.stop(), webhookScheduler?.stop(), emailReportScheduler?.stop()])
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

if (config.inboundCampaignsToken === undefined) {
  logger.info(
    'POST /inbound/salesforce/opportunities disabled (INBOUND_CAMPAIGNS_TOKEN is not set)',
  )
}

if (!config.provisioningEnabled) {
  logger.info(
    'provisioning on Salesforce push disabled (PROVISIONING_ENABLED is not true); POST /campaigns/:id/provision still works',
  )
}

if (config.publicBaseUrl === undefined) {
  logger.info('csv webhooks unavailable (neither PUBLIC_BASE_URL nor RENDER_EXTERNAL_URL is set)')
}

if (config.mail === undefined) {
  logger.info('email off (MAIL_PROVIDER is not set): email reports are not sent')
} else if (config.mail.provider.name === 'memory') {
  logger.warn('MAIL_PROVIDER=memory: emails are kept in this process and never sent')
}

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

if (!config.emailReportSchedulerEnabled) {
  logger.info('email report scheduler disabled (EMAIL_REPORT_SCHEDULER_ENABLED=false)')
} else if (mailer !== undefined && !shutdown.signal.aborted) {
  emailReportScheduler = startEmailReportScheduler({ ...emailReports, mailer })
}
