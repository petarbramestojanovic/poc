import { destination } from 'pino'
import { loadRuntimeConfig, type RuntimeConfig } from '../core/config.ts'
import { createDb, type Db } from '../core/db.ts'
import { createHttpClient } from '../core/http/HttpClient.ts'
import { redact } from '../core/http/redact.ts'
import { createLogger } from '../core/log.ts'
import { verifyIndustryMap } from '../modules/industries/service.ts'
import { UsageError } from './args.ts'
import {
  executeIndustryCommand,
  INDUSTRIES_USAGE,
  parseIndustryArgs,
  type IndustryCommand,
} from './industries-commands.ts'

// Operator entry point: `npm run industries -- backfill [--dry-run] [--reclassify]`.
// Arguments are checked before the database is touched. Logs go to stderr, so stdout carries only
// results. Ctrl+C stops before the next campaign; what is done stays done. A second Ctrl+C exits.

const lines = (stream: NodeJS.WriteStream) => (line: string) => {
  stream.write(`${line}\n`)
}

async function main(argv: readonly string[]): Promise<number> {
  let command: IndustryCommand
  try {
    command = parseIndustryArgs(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`${error.message}\n\n${INDUSTRIES_USAGE}`)
    return 2
  }
  if (command.kind === 'help') {
    process.stdout.write(INDUSTRIES_USAGE)
    return 0
  }

  const controller = new AbortController()
  process.once('SIGINT', () => {
    process.stderr.write('\nStopping before the next campaign. Press Ctrl+C again to exit now.\n')
    controller.abort(new Error('SIGINT'))
    process.once('SIGINT', () => {
      process.exit(130)
    })
  })

  let db: Db
  let config: RuntimeConfig
  const logger = createLogger('info', destination({ dest: 2, sync: true }))
  try {
    config = loadRuntimeConfig()
    db = createDb(config.databaseUrl, {
      logger,
      ssl: config.databaseSsl,
      sslCa: config.databaseSslCa,
    })
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  }

  try {
    // The same check the service boots with: a bad keyword table would only fail row by row.
    await verifyIndustryMap(db)
    return await executeIndustryCommand(command, {
      industries: {
        db,
        // The service's LLM client: 15 s per attempt, two retries.
        http: createHttpClient({ log: logger, timeoutMs: 15_000, maxRetries: 2 }),
        log: logger,
        ...(config.openRouterApiKey === undefined ? {} : { apiKey: config.openRouterApiKey }),
      },
      signal: controller.signal,
      io: { out: lines(process.stdout), err: lines(process.stderr) },
    })
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  } finally {
    await db.close()
  }
}

process.exitCode = await main(process.argv.slice(2))
