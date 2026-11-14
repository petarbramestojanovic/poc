import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/core/log.ts'
import {
  InvalidMailError,
  MailRejectedError,
  MailUnavailableError,
} from '../../src/core/mail/errors.ts'
import {
  checkMessage,
  createMailer,
  MAX_MESSAGE_BYTES,
  mailerFor,
  messageBytes,
} from '../../src/core/mail/mailer.ts'
import { createMemoryProvider } from '../../src/core/mail/providers/memory/provider.ts'
import type { MailMessage } from '../../src/core/mail/types.ts'
import { createHttpClient } from '../../src/core/http/HttpClient.ts'

const log = createLogger('silent')
const ctx = { log }

const csv = 'Date,Campaign,Impressions\n2026-11-14,Grüezi,10\n'

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  to: ['anna@example.com', 'ben@example.com'],
  subject: 'Tchibo Always-on, 2026-11-14',
  text: 'Attached is the report for 2026-11-14.',
  attachments: [
    { filename: 'report_2026-11-14.csv', contentType: 'text/csv; charset=utf-8', content: csv },
  ],
  idempotencyKey: 'delivery-1:abc',
  ...overrides,
})

function setup(
  settings: { from: string; replyTo?: string } = { from: 'Klea Analytics <reports@example.com>' },
) {
  const provider = createMemoryProvider()
  return { provider, mailer: mailerFor(provider, settings) }
}

describe('mailer', () => {
  it('sends with the configured sender and reply-to, never one from the caller', async () => {
    const { provider, mailer } = setup({
      from: '  Klea Analytics   <reports@example.com>',
      replyTo: 'team@example.com',
    })
    const result = await mailer.send(message(), ctx)

    expect(result).toEqual({ provider: 'memory', messageId: 'memory-1' })
    expect(mailer.provider).toBe('memory')
    expect(provider.sent).toHaveLength(1)
    expect(provider.sent[0]?.mail).toEqual({
      from: 'Klea Analytics <reports@example.com>',
      replyTo: 'team@example.com',
      to: ['anna@example.com', 'ben@example.com'],
      subject: 'Tchibo Always-on, 2026-11-14',
      text: 'Attached is the report for 2026-11-14.',
      attachments: [
        { filename: 'report_2026-11-14.csv', contentType: 'text/csv; charset=utf-8', content: csv },
      ],
      idempotencyKey: 'delivery-1:abc',
    })
  })

  it('has no reply-to unless configured, and sends a message without attachments', async () => {
    const { provider, mailer } = setup()
    const { attachments: _attachments, ...bare } = message()
    await mailer.send(bare, ctx)
    expect(provider.sent[0]?.mail).not.toHaveProperty('replyTo')
    expect(provider.sent[0]?.mail.attachments).toEqual([])
  })

  it('refuses a sender or reply-to that is not an address', () => {
    const provider = createMemoryProvider()
    expect(() => mailerFor(provider, { from: 'Klea, Analytics <r@example.com>' })).toThrow(
      InvalidMailError,
    )
    expect(() => mailerFor(provider, { from: 'r@example.com', replyTo: 'not an address' })).toThrow(
      InvalidMailError,
    )
  })

  it.each([
    ['no recipient', { to: [] }, 'at least one recipient'],
    [
      'too many recipients',
      { to: Array.from({ length: 51 }, (_, i) => `r${i}@example.com`) },
      'at most 50',
    ],
    [
      'a malformed recipient',
      { to: ['anna@example.com', 'ben@'] },
      'Recipient 2 is not an email address',
    ],
    [
      'a recipient listed twice',
      { to: ['anna@example.com', 'ANNA@example.com'] },
      'Recipient 2 is listed twice',
    ],
    ['an empty subject', { subject: '  ' }, 'subject is empty'],
    ['a subject with a line break', { subject: 'Report\r\nBcc: x@example.com' }, 'line break'],
    ['a subject over 250 characters', { subject: 'x'.repeat(251) }, 'longer than 250'],
    ['an empty idempotency key', { idempotencyKey: '' }, 'idempotency key'],
    ['an idempotency key with a space', { idempotencyKey: 'a b' }, 'idempotency key'],
    [
      'an idempotency key over 256 characters',
      { idempotencyKey: 'k'.repeat(257) },
      'idempotency key',
    ],
    [
      'a file name with a slash',
      { attachments: [{ filename: '../x.csv', contentType: 'text/csv', content: '' }] },
      'Attachment 1 needs a file name',
    ],
    [
      'a file name with a quote',
      { attachments: [{ filename: 'a".csv', contentType: 'text/csv', content: '' }] },
      'Attachment 1 needs a file name',
    ],
    [
      'a content type with a line break',
      { attachments: [{ filename: 'a.csv', contentType: 'text/csv\r\nX: y', content: '' }] },
      'no usable content type',
    ],
    [
      'eleven attachments',
      {
        attachments: Array.from({ length: 11 }, (_, i) => ({
          filename: `${i}.csv`,
          contentType: 'text/csv',
          content: '',
        })),
      },
      'at most 10 attachments',
    ],
  ])('refuses %s before any provider sees it', async (_name, overrides, text) => {
    const { provider, mailer } = setup()
    const error = await mailer
      .send(message(overrides as Partial<MailMessage>), ctx)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvalidMailError)
    expect((error as Error).message).toContain(text)
    expect((error as InvalidMailError).code).toBe('invalid_mail')
    expect(provider.sent).toHaveLength(0)
  })

  it('never quotes an address in its refusal', async () => {
    const { mailer } = setup()
    const error = await mailer
      .send(message({ to: ['secret.person@example.com', 'secret.person@example.com'] }), ctx)
      .catch((e: unknown) => e)
    expect((error as Error).message).not.toContain('secret.person')
  })

  it('refuses a message over 10 MB counted as it travels (attachments as base64)', async () => {
    const { mailer } = setup()
    // 8.2 MB of text is 10.9 MB as base64: under the cap raw, over it encoded.
    const content = 'x'.repeat(Math.floor((MAX_MESSAGE_BYTES * 3) / 4) + 300_000)
    const big = message({
      attachments: [{ filename: 'big.csv', contentType: 'text/csv', content }],
    })
    await expect(mailer.send(big, ctx)).rejects.toThrow('over the 10485760-byte limit')

    const fits = message({
      attachments: [
        { filename: 'ok.csv', contentType: 'text/csv', content: 'x'.repeat(7_000_000) },
      ],
    })
    await expect(mailer.send(fits, ctx)).resolves.toMatchObject({ provider: 'memory' })
  })

  it('counts UTF-8 bytes, not characters', () => {
    const mail = checkMessage(
      message({
        subject: 'ü',
        text: '',
        attachments: [{ filename: 'a', contentType: 'text/csv', content: 'üüü' }],
      }),
      'r@example.com',
    )
    // subject 2 bytes + attachment 6 bytes → 8 base64 characters + file name 1 byte.
    expect(messageBytes(mail)).toBe(2 + 8 + 1)
  })

  it('does not send once the signal is aborted', async () => {
    const { provider, mailer } = setup()
    const controller = new AbortController()
    controller.abort(new Error('shutting down'))
    await expect(mailer.send(message(), { log, signal: controller.signal })).rejects.toThrow(
      'shutting down',
    )
    expect(provider.sent).toHaveLength(0)
  })

  it('passes a provider failure through unchanged', async () => {
    const { provider, mailer } = setup()
    const unavailable = new MailUnavailableError(
      { provider: 'memory', providerStatus: 503 },
      'down',
    )
    provider.failNext(unavailable)
    await expect(mailer.send(message(), ctx)).rejects.toBe(unavailable)
    await expect(mailer.send(message(), ctx)).resolves.toMatchObject({ messageId: 'memory-1' })
  })

  it('builds the configured provider', () => {
    const http = createHttpClient({ log })
    expect(
      createMailer({ provider: { name: 'memory' }, from: 'r@example.com' }, { http }).provider,
    ).toBe('memory')
    expect(
      createMailer(
        { provider: { name: 'resend', apiKey: 're_test' }, from: 'r@example.com' },
        { http },
      ).provider,
    ).toBe('resend')
  })
})

describe('memory provider', () => {
  it('behaves like Resend for a repeated key: same message once, a changed message refused', async () => {
    const { provider, mailer } = setup()
    const first = await mailer.send(message(), ctx)
    const again = await mailer.send(message(), ctx)
    expect(again).toEqual(first)
    expect(provider.sent).toHaveLength(1)

    const changed = await mailer
      .send(message({ text: 'Rebuilt document' }), ctx)
      .catch((e: unknown) => e)
    expect(changed).toBeInstanceOf(MailRejectedError)
    expect(changed).toMatchObject({ providerCode: 'invalid_idempotent_request', retryable: false })
    expect(provider.sent).toHaveLength(1)

    await mailer.send(message({ text: 'Rebuilt document', idempotencyKey: 'delivery-1:def' }), ctx)
    expect(provider.sent.map((kept) => kept.messageId)).toEqual(['memory-1', 'memory-2'])
  })

  it('keeps only the last 100 messages', async () => {
    const { provider, mailer } = setup()
    for (let i = 0; i < 105; i++) await mailer.send(message({ idempotencyKey: `k${i}` }), ctx)
    expect(provider.sent).toHaveLength(100)
    expect(provider.sent[0]?.messageId).toBe('memory-6')
    provider.clear()
    expect(provider.sent).toHaveLength(0)
  })
})
