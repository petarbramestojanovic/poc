import { destination } from 'pino'
import { loadMailConfig } from '../core/config.ts'
import { redact } from '../core/http/redact.ts'
import { createLogger } from '../core/log.ts'
import { createMailer } from '../core/mail/mailer.ts'
import type { Mailer } from '../core/mail/types.ts'
import { createMailHttpClient } from '../runtime.ts'
import { UsageError } from './args.ts'
import { executeMailCommand, MAIL_USAGE, parseMailArgs, type MailCommand } from './mail-commands.ts'

// Operator entry point: `npm run mail -- test --to <address>`. Reads only the mail settings
// (MAIL_PROVIDER, its key, MAIL_FROM, MAIL_REPLY_TO); no database. Logs go to stderr.

const lines = (stream: NodeJS.WriteStream) => (line: string) => {
  stream.write(`${line}\n`)
}

async function main(argv: readonly string[]): Promise<number> {
  let command: MailCommand
  try {
    command = parseMailArgs(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`${error.message}\n\n${MAIL_USAGE}`)
    return 2
  }
  if (command.kind === 'help') {
    process.stdout.write(MAIL_USAGE)
    return 0
  }

  const logger = createLogger('info', destination({ dest: 2, sync: true }))
  let mailer: Mailer
  try {
    const config = loadMailConfig()
    if (config === undefined) {
      process.stderr.write('Email is off: set MAIL_PROVIDER, MAIL_FROM and the provider key.\n')
      return 1
    }
    mailer = createMailer(config, { http: createMailHttpClient(logger) })
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  }

  const controller = new AbortController()
  process.once('SIGINT', () => {
    controller.abort(new Error('SIGINT'))
  })
  return executeMailCommand(command, {
    mailer,
    log: logger,
    signal: controller.signal,
    now: () => new Date(),
    io: { out: lines(process.stdout), err: lines(process.stderr) },
  })
}

process.exitCode = await main(process.argv.slice(2))
