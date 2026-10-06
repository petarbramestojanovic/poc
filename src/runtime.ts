import type { RuntimeConfig } from './config.ts'
import { createDb, type Db } from './db.ts'
import { createHttpClient, type HttpClient } from './http/HttpClient.ts'
import { createLimiter, type Limiter } from './limiter.ts'
import { createLogger, type Logger } from './log.ts'
import { createDefaultRegistry } from './sync/connectors/index.ts'
import { SYNC_MAX_CONNECTIONS, verifyRegistryAgainstSources } from './sync/engine.ts'
import type { ConnectorRegistry } from './sync/registry.ts'

// The one place the sync machinery is assembled. The service and the operator CLI both call it,
// so a CLI run uses exactly the pool settings, HTTP client, connectors and pool share the nightly
// job uses.

/**
 * The client that POSTs to client endpoints: one attempt, 10 s, and no retry inside the request.
 * Webhook retries are the delivery ladder in the database (1 m, 5 m, 30 m, 2 h, 12 h), which
 * survives a restart; an in-process retry would not, and would hold the tick open for minutes.
 */
export function createWebhookHttpClient(logger: Logger): HttpClient {
  return createHttpClient({ log: logger, maxRetries: 0, timeoutMs: WEBHOOK_TIMEOUT_MS })
}

/** RFC-002 §15.4: 10 s per attempt. */
export const WEBHOOK_TIMEOUT_MS = 10_000

export interface SyncRuntime {
  logger: Logger
  db: Db
  http: HttpClient
  registry: ConnectorRegistry
  /** One per process: it caps this process's sync share of the pool. */
  limiter: Limiter
}

export async function createSyncRuntime(
  config: RuntimeConfig,
  logger: Logger = createLogger(config.logLevel),
): Promise<SyncRuntime> {
  const db = createDb(config.databaseUrl, {
    logger,
    ssl: config.databaseSsl,
    sslCa: config.databaseSslCa,
  })
  const registry = createDefaultRegistry()
  try {
    // Fail at startup, not in the 04:00 run, if connectors and external.source disagree.
    await verifyRegistryAgainstSources(db, registry)
  } catch (error) {
    await db.close()
    throw error
  }
  return {
    logger,
    db,
    http: createHttpClient({ log: logger }),
    registry,
    limiter: createLimiter(SYNC_MAX_CONNECTIONS),
  }
}
