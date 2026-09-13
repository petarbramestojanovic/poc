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
