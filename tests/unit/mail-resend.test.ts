import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createHttpClient, NetworkError } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import { MailRejectedError, MailUnavailableError } from '../../src/core/mail/errors.ts'
import { mailerFor } from '../../src/core/mail/mailer.ts'
import {
  readResendAnswer,
  RESEND_EMAILS_URL,
  RESEND_USER_AGENT,
  toResendBody,
  toResendHeaders,
} from '../../src/core/mail/providers/resend/mapper.ts'
import { createResendProvider } from '../../src/core/mail/providers/resend/provider.ts'
import type { MailMessage, OutgoingMail } from '../../src/core/mail/types.ts'
import { createMailHttpClient } from '../../src/runtime.ts'

// The answers in fixtures/ follow Resend's API reference (send-email, errors, idempotency keys,
// read 2026-11-14): the error names and statuses are Resend's; the body shape { statusCode, name,
// message } is the one its SDK reads, which the errors page does not show.

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../src/core/mail/providers/resend/fixtures/${name}.json`, import.meta.url),
      'utf8',
    ),
  )

const log = createLogger('silent')
const API_KEY = 're_test_0123456789abcdef'

const csv = 'Date,Campaign,Impressions\n2026-11-14,Grüezi,10\n'
const mail: OutgoingMail = {
  from: 'Klea Analytics <reports@example.com>',
  replyTo: 'team@example.com',
  to: ['anna@example.com', 'ben@example.com'],
  subject: 'Tchibo Always-on, 2026-11-14',
  text: 'Attached is the report for 2026-11-14.',
  attachments: [
    { filename: 'report_2026-11-14.csv', contentType: 'text/csv; charset=utf-8', content: csv },
  ],
  idempotencyKey: 'delivery-1:abc',
}

describe('Resend mapper', () => {
  it('builds the exact request body, the CSV as base64 of its UTF-8 bytes', () => {
    const body = toResendBody(mail)
    expect(body).toEqual({
      from: 'Klea Analytics <reports@example.com>',
      to: ['anna@example.com', 'ben@example.com'],
      subject: 'Tchibo Always-on, 2026-11-14',
      text: 'Attached is the report for 2026-11-14.',
      reply_to: 'team@example.com',
      attachments: [
        {
          filename: 'report_2026-11-14.csv',
          content: Buffer.from(csv, 'utf8').toString('base64'),
          content_type: 'text/csv; charset=utf-8',
        },
      ],
    })
    // The umlaut survives the round trip.
    expect(Buffer.from(body.attachments?.[0]?.content ?? '', 'base64').toString('utf8')).toBe(csv)
  })

  it('leaves out reply_to and attachments when there are none', () => {
    const { replyTo: _replyTo, ...bare } = mail
    const body = toResendBody({ ...bare, attachments: [] })
    expect(body).not.toHaveProperty('reply_to')
    expect(body).not.toHaveProperty('attachments')
  })

  it('sends the key, the idempotency key and a User-Agent (Resend refuses a request without one)', () => {
    expect(toResendHeaders(API_KEY, mail)).toEqual({
      authorization: `Bearer ${API_KEY}`,
      'idempotency-key': 'delivery-1:abc',
      'user-agent': RESEND_USER_AGENT,
    })
  })

  it('reads an accepted message', () => {
    expect(readResendAnswer(200, fixture('sent'))).toEqual({
      provider: 'resend',
      messageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
    })
  })

  it.each([
    ['the test sender writing to someone else', 403, 'testing-domain', 'validation_error'],
    ['a wrong key', 401, 'invalid-key', 'validation_error'],
    ['a key reused with a different message', 409, 'changed-key', 'invalid_idempotent_request'],
  ])('refuses for good on %s', (_name, status, file, code) => {
    const answer = readResendAnswer(status, fixture(file))
    expect(answer).toBeInstanceOf(MailRejectedError)
    expect(answer).toMatchObject({
      code: 'mail_rejected',
      retryable: false,
      provider: 'resend',
      providerStatus: status,
      providerCode: code,
    })
  })

  it.each([
    ['a rate limit', 429, 'rate-limited', 'rate_limit_exceeded'],
    [
      'a key whose first request is still running',
      409,
      'concurrent-key',
      'concurrent_idempotent_requests',
    ],
    ['an error on their side', 500, 'server-error', 'application_error'],
  ])(
    'reports unavailable on %s, so the same message may be sent again',
    (_name, status, file, code) => {
      const answer = readResendAnswer(status, fixture(file))
      expect(answer).toBeInstanceOf(MailUnavailableError)
      expect(answer).toMatchObject({
        code: 'mail_unavailable',
        retryable: true,
        providerCode: code,
      })
    },
  )

  it('classifies by status when the body is not Resend JSON (e.g. a proxy page)', () => {
    expect(readResendAnswer(403, undefined)).toBeInstanceOf(MailRejectedError)
    expect(readResendAnswer(502, undefined)).toBeInstanceOf(MailUnavailableError)
    expect(readResendAnswer(503, 'error code: 1010')).toMatchObject({ providerStatus: 503 })
  })

  it('treats a 200 without an id as unavailable: sending again with the key is safe', () => {
    expect(readResendAnswer(200, { ok: true })).toBeInstanceOf(MailUnavailableError)
  })

  it("never keeps an address from Resend's message", () => {
    const answer = readResendAnswer(403, fixture('testing-domain')) as MailRejectedError
    expect(answer.message).toContain('You can only send testing emails to your own email address')
    expect(answer.message).not.toContain('owner@example.com')
    expect(answer.message).toContain('[address]')
  })
})

type Reply = { status: number; body?: unknown } | Error

function fakeResend(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('no reply scripted')
    if (reply instanceof Error) throw reply
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const message: MailMessage = {
  to: ['anna@example.com'],
  subject: 'Report',
  text: 'Attached.',
  attachments: [{ filename: 'r.csv', contentType: 'text/csv; charset=utf-8', content: csv }],
  idempotencyKey: 'delivery-2:abc',
}

function resendMailer(replies: Reply[]) {
  const fake = fakeResend(replies)
  // The service's own client: one attempt, no in-process retry.
  const http = createHttpClient({ log, fetch: fake.fetch, maxRetries: 0, timeoutMs: 1_000 })
  const mailer = mailerFor(createResendProvider({ apiKey: API_KEY, http }), {
    from: 'Klea Analytics <reports@example.com>',
  })
  return { mailer, calls: fake.calls }
}

describe('Resend provider', () => {
  it('POSTs one JSON request with the key, the idempotency key and the User-Agent', async () => {
    const { mailer, calls } = resendMailer([{ status: 200, body: fixture('sent') }])
    await expect(mailer.send(message, { log })).resolves.toEqual({
      provider: 'resend',
      messageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
    })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe(RESEND_EMAILS_URL)
    expect(call?.init.method).toBe('POST')
    expect(call?.init.redirect).toBe('error')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(headers['idempotency-key']).toBe('delivery-2:abc')
    expect(headers['user-agent']).toBe(RESEND_USER_AGENT)
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(call?.init.body as string)).toMatchObject({
      from: 'Klea Analytics <reports@example.com>',
      to: ['anna@example.com'],
    })
  })

  it.each([
    [401, 'invalid-key', MailRejectedError],
    [403, 'testing-domain', MailRejectedError],
    [429, 'rate-limited', MailUnavailableError],
    [500, 'server-error', MailUnavailableError],
  ])('turns HTTP %i into the right error after one attempt', async (status, file, type) => {
    const { mailer, calls } = resendMailer([
      { status, body: fixture(file) },
      { status: 200, body: fixture('sent') },
    ])
    await expect(mailer.send(message, { log })).rejects.toBeInstanceOf(type)
    expect(calls).toHaveLength(1)
  })

  it('reports a network failure as unavailable, keeping the cause', async () => {
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    })
    const { mailer } = resendMailer([reset])
    const error = await mailer.send(message, { log }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailUnavailableError)
    expect((error as Error).cause).toBeInstanceOf(NetworkError)
    expect((error as Error).message).not.toContain(API_KEY)
  })

  it('lets an abort through as an abort, not as a mail error', async () => {
    const controller = new AbortController()
    const { mailer, calls } = resendMailer([{ status: 200, body: fixture('sent') }])
    controller.abort(new Error('shutting down'))
    await expect(mailer.send(message, { log, signal: controller.signal })).rejects.toThrow(
      'shutting down',
    )
    expect(calls).toHaveLength(0)
  })

  it('is used by the service with one attempt and no in-process retry', async () => {
    const fake = fakeResend([{ status: 503 }, { status: 200, body: fixture('sent') }])
    vi.stubGlobal('fetch', fake.fetch)
    try {
      const provider = createResendProvider({ apiKey: API_KEY, http: createMailHttpClient(log) })
      const mailer = mailerFor(provider, { from: 'reports@example.com' })
      await expect(mailer.send(message, { log })).rejects.toBeInstanceOf(MailUnavailableError)
      expect(fake.calls).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
