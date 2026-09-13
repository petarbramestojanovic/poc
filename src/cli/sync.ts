import { destination } from 'pino'
import { loadRuntimeConfig } from '../config.ts'
import { redact } from '../http/redact.ts'
import { createLogger } from '../log.ts'
import { createSyncRuntime, type SyncRuntime } from '../runtime.ts'
import { parseSyncArgs, USAGE, UsageError, type SyncCommand } from './args.ts'
import { executeSyncCommand } from './sync-commands.ts'

// Operator entry point: `npm run sync -- …` (modes in ./args.ts).
// Arguments are checked before the database is touched. Logs go to stderr, so stdout carries only
// results. Ctrl+C aborts cleanly: an in-flight run stops before its next day and is recorded as
// aborted. A second Ctrl+C exits immediately.

const lines = (stream: NodeJS.WriteStream) => (line: string) => {
  stream.write(`${line}\n`)
}

async function main(argv: readonly string[]): Promise<number> {
  let command: SyncCommand
  try {
    command = parseSyncArgs(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (command.kind === 'help') {
    process.stdout.write(USAGE)
    return 0
  }

  const controller = new AbortController()
  process.once('SIGINT', () => {
    process.stderr.write('\nStopping before the next day. Press Ctrl+C again to exit now.\n')
    controller.abort(new Error('SIGINT'))
    process.once('SIGINT', () => {
      process.exit(130)
    })
  })

  let runtime: SyncRuntime
  try {
    const config = loadRuntimeConfig()
    const logger = createLogger(config.logLevel, destination({ dest: 2, sync: true }))
    runtime = await createSyncRuntime(config, logger)
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  }

  try {
    return await executeSyncCommand(command, {
      runtime,
      signal: controller.signal,
      io: { out: lines(process.stdout), err: lines(process.stderr) },
    })
  } finally {
    await runtime.db.close()
  }
}

process.exitCode = await main(process.argv.slice(2))
