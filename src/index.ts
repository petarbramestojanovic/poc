import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createDb } from './db.ts'
import { createLogger } from './log.ts'

const config = loadConfig()
const logger = createLogger(config.logLevel)
const db = createDb(config.databaseUrl)
const app = buildApp({ config, db, logger })

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down')
  await app.close()
  await db.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ port: config.port, host: '0.0.0.0' })
