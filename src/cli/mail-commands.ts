import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import type { Logger } from '../core/log.ts'
import { isEmailAddress } from '../core/mail/address.ts'
import { MailError } from '../core/mail/errors.ts'
import { MAX_RECIPIENTS } from '../core/mail/mailer.ts'
import type { Mailer, MailMessage } from '../core/mail/types.ts'
import { UsageError } from './args.ts'

// `npm run mail -- …`: checks the mail provider, its key and the sender's domain by sending one
// short email with a small CSV attached, without a report or a database. Free of process I/O, so
// every mode and misuse is unit tested.

export type MailCommand = { kind: 'help' } | { kind: 'test'; to: string[] }

export const MAIL_USAGE = `Usage:
  npm run mail -- test --to <address> [--to <address> …]

  test   Send a short test email with a small CSV attached, through MAIL_PROVIDER, from MAIL_FROM.
         It checks the key, the sender's domain and attachments without creating a report.
         With Resend's test sender (onboarding@resend.dev), only the account's own address receives it.
`

export function parseMailArgs(argv: readonly string[]): MailCommand {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        to: { type: 'string', multiple: true },
      },
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals } = parsed
  if (values.help === true) return { kind: 'help' }

  const [mode, ...extra] = positionals
  if (mode !== 'test') throw new UsageError(`Choose a command: test.`)
  if (extra.length > 0) throw new UsageError(`Unexpected argument: ${extra.join(' ')}.`)

  const to = values.to ?? []
  if (to.length === 0) throw new UsageError('test needs at least one --to <address>.')
  if (to.length > MAX_RECIPIENTS) {
    throw new UsageError(`test sends to at most ${MAX_RECIPIENTS} addresses.`)
  }
  for (const [index, address] of to.entries()) {
    if (!isEmailAddress(address))
      throw new UsageError(`--to number ${index + 1} is not an email address.`)
  }
  return { kind: 'test', to }
}

/**
 * The test email. The CSV holds a non-ASCII name, so a wrong encoding on the way shows in the
 * file. A fresh idempotency key each time: every run is a new email.
 */
export function buildTestMail(to: readonly string[], now: Date): MailMessage {
  const sentAt = now.toISOString()
  return {
    to,
    subject: `Test email from the analytics service (${sentAt})`,
    text: [
      'This is a test of the analytics service email settings.',
      '',
      `Sent at ${sentAt} UTC. The attached CSV has a header and two rows.`,
      'If it arrived with the file, the key, the sender and attachments work.',
    ].join('\n'),
    attachments: [
      {
        filename: 'mail-test.csv',
        contentType: 'text/csv; charset=utf-8',
        content: 'Row,Text\n1,Grüezi\n2,Ünïcode check\n',
      },
    ],
    idempotencyKey: `mail-test-${randomUUID()}`,
  }
}

export interface MailCommandDeps {
  mailer: Mailer
  log: Logger
  signal: AbortSignal
  now: () => Date
  io: { out: (line: string) => void; err: (line: string) => void }
}

export async function executeMailCommand(
  command: Extract<MailCommand, { kind: 'test' }>,
  deps: MailCommandDeps,
): Promise<number> {
  try {
    const result = await deps.mailer.send(buildTestMail(command.to, deps.now()), {
      log: deps.log,
      signal: deps.signal,
    })
    deps.io.out(`Accepted by ${result.provider}: message id ${result.messageId}.`)
    deps.io.out(
      `Check the inbox (and spam) of ${command.to.length === 1 ? 'the recipient' : `the ${command.to.length} recipients`}.`,
    )
    return 0
  } catch (error) {
    if (!(error instanceof MailError)) throw error
    deps.io.err(`Not sent (${error.code}): ${error.message}`)
    return 1
  }
}
