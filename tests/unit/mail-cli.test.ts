import { describe, expect, it } from 'vitest'
import { UsageError } from '../../src/cli/args.ts'
import { buildTestMail, executeMailCommand, parseMailArgs } from '../../src/cli/mail-commands.ts'
import { createLogger } from '../../src/core/log.ts'
import { MailRejectedError } from '../../src/core/mail/errors.ts'
import { mailerFor } from '../../src/core/mail/mailer.ts'
import { createMemoryProvider } from '../../src/core/mail/providers/memory/provider.ts'

const log = createLogger('silent')

describe('parseMailArgs', () => {
  it('reads test with one or more --to', () => {
    expect(parseMailArgs(['test', '--to', 'anna@example.com'])).toEqual({
      kind: 'test',
      to: ['anna@example.com'],
    })
    expect(parseMailArgs(['test', '--to', 'anna@example.com', '--to', 'ben@example.com'])).toEqual({
      kind: 'test',
      to: ['anna@example.com', 'ben@example.com'],
    })
    expect(parseMailArgs(['--help'])).toEqual({ kind: 'help' })
  })

  it.each([
    ['no command', [], 'Choose a command'],
    ['an unknown command', ['send', '--to', 'a@example.com'], 'Choose a command'],
    ['no recipient', ['test'], 'at least one --to'],
    ['a malformed recipient, without echoing it', ['test', '--to', 'anna'], '--to number 1'],
    ['an unknown flag', ['test', '--to', 'a@example.com', '--cc', 'b@example.com'], 'cc'],
    ['an extra argument', ['test', 'now', '--to', 'a@example.com'], 'Unexpected argument'],
  ])('refuses %s', (_name, argv, text) => {
    expect(() => parseMailArgs(argv)).toThrow(UsageError)
    expect(() => parseMailArgs(argv)).toThrow(text)
  })
})

describe('mail test', () => {
  const now = () => new Date('2026-11-14T13:00:00.000Z')

  function run(provider = createMemoryProvider()) {
    const out: string[] = []
    const err: string[] = []
    const mailer = mailerFor(provider, { from: 'Klea Analytics <reports@example.com>' })
    const deps = {
      mailer,
      log,
      signal: new AbortController().signal,
      now,
      io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    }
    return { provider, out, err, deps }
  }

  it('sends one email with a UTF-8 CSV and prints the message id', async () => {
    const { provider, out, deps } = run()
    const code = await executeMailCommand(
      { kind: 'test', to: ['anna@example.com', 'ben@example.com'] },
      deps,
    )
    expect(code).toBe(0)
    expect(out).toEqual([
      'Accepted by memory: message id memory-1.',
      'Check the inbox (and spam) of the 2 recipients.',
    ])
    const sent = provider.sent[0]?.mail
    expect(sent?.to).toEqual(['anna@example.com', 'ben@example.com'])
    expect(sent?.attachments).toEqual([
      {
        filename: 'mail-test.csv',
        contentType: 'text/csv; charset=utf-8',
        content: 'Row,Text\n1,Grüezi\n2,Ünïcode check\n',
      },
    ])
    expect(sent?.subject).toBe('Test email from the analytics service (2026-11-14T13:00:00.000Z)')
  })

  it('uses a new idempotency key for every run', () => {
    const a = buildTestMail(['anna@example.com'], now())
    const b = buildTestMail(['anna@example.com'], now())
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey)
  })

  it('prints why a refused email was not sent and exits 1', async () => {
    const provider = createMemoryProvider()
    provider.failNext(
      new MailRejectedError(
        { provider: 'memory', providerStatus: 403, providerCode: 'validation_error' },
        'You can only send testing emails to your own email address (owner@example.com).',
      ),
    )
    const { err, deps } = run(provider)
    expect(await executeMailCommand({ kind: 'test', to: ['anna@example.com'] }, deps)).toBe(1)
    expect(err).toEqual([
      'Not sent (mail_rejected): You can only send testing emails to your own email address ([address]).',
    ])
  })
})
