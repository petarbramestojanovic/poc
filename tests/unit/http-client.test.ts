import { describe, expect, it, vi } from 'vitest'
import {
  backoffDelayMs,
  createHttpClient,
  DeadlineExceededError,
  HttpError,
  isRetryableStatus,
  NetworkError,
  ResponseBodyError,
  ResponseTooLargeError,
  retryAfterMs,
  RetryBudgetExhaustedError,
  type HttpClientOptions,
} from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'

const log = createLogger('silent')

type Reply =
  | { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }
  | Error
  | (() => Response)

const transient = (code: string) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(`socket ${code}`), { code }) })

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('no reply scripted')
    if (reply instanceof Error) throw reply
    if (typeof reply === 'function') return reply()
    const body = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
    return new Response(
      body,
      reply.headers ? { status: reply.status, headers: reply.headers } : { status: reply.status },
    )
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

function client(replies: Reply[], extra: Partial<HttpClientOptions> = {}) {
  const sleeps: number[] = []
  const { impl, calls } = fakeFetch(replies)
  const http = createHttpClient({
    log,
    fetch: impl,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    random: () => 0.5,
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    ...extra,
  })
  return { http, calls, sleeps }
}

const GET = { method: 'GET' as const, url: 'https://api.example/x', credentialKey: 'c1' }

describe('backoffDelayMs', () => {
  it('uses full jitter over the capped exponential range with a floor of half the base', () => {
    const opts = { baseDelayMs: 500, maxDelayMs: 30_000 }
    expect([0, 1, 2, 3, 4].map((a) => backoffDelayMs(a, opts, () => 0))).toEqual([
      250, 250, 250, 250, 250,
    ])
    expect([0, 1, 2, 3, 4].map((a) => backoffDelayMs(a, opts, () => 1))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000,
    ])
    expect(backoffDelayMs(10, opts, () => 1)).toBe(30_000)
    expect(backoffDelayMs(10, opts, () => 0)).toBe(250)
  })
})

describe('retry classification', () => {
  it('retries 408, 429 and transient 5xx but not 501 or 505', () => {
    expect([408, 429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true)
    expect([400, 401, 404, 501, 505].some(isRetryableStatus)).toBe(false)
  })

  it('parses both Retry-After forms and ignores non-positive values', () => {
    const now = Date.UTC(2026, 8, 13, 12, 0, 0)
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }), now)).toBe(3_000)
    expect(
      retryAfterMs(new Headers({ 'retry-after': new Date(now + 5_000).toUTCString() }), now),
    ).toBe(5_000)
    expect(retryAfterMs(new Headers({ 'retry-after': '0' }), now)).toBeUndefined()
    expect(
      retryAfterMs(new Headers({ 'retry-after': new Date(now - 5_000).toUTCString() }), now),
    ).toBeUndefined()
    expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }), now)).toBeUndefined()
    expect(retryAfterMs(new Headers(), now)).toBeUndefined()
  })
})

describe('HttpClient', () => {
  it('returns parsed JSON on 2xx, sends JSON bodies and refuses redirects', async () => {
    const { http, calls } = client([{ status: 200, body: { ok: true } }])
    const res = await http.request({
      ...GET,
      method: 'POST',
      body: { a: 1 },
      headers: { authorization: 'Bearer k' },
    })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(calls[0]?.init.body).toBe('{"a":1}')
    expect(calls[0]?.init.redirect).toBe('error')
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer k',
      'content-type': 'application/json',
    })
  })

  it('retries 5xx and transient network errors with the backoff schedule', async () => {
    const { http, sleeps, calls } = client([
      { status: 503 },
      transient('ECONNRESET'),
      { status: 500 },
      { status: 200, body: 1 },
    ])
    const res = await http.request(GET)
    expect(res.json()).toBe(1)
    expect(calls).toHaveLength(4)
    expect(sleeps).toEqual([75, 125, 225])
  })

  it('does not retry programmer errors or non-transient network failures', async () => {
    const bug = client([new Error('mapper bug'), { status: 200 }])
    await expect(bug.http.request(GET)).rejects.toThrow('mapper bug')
    expect(bug.calls).toHaveLength(1)

    const tls = client([
      new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }),
      { status: 200 },
    ])
    const error = await tls.http.request(GET).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NetworkError)
    expect(error).toMatchObject({ code: 'CERT_HAS_EXPIRED', retryable: false })
    expect(tls.calls).toHaveLength(1)
  })

  it('keeps the network cause code on the error it finally throws', async () => {
    const { http } = client([transient('EAI_AGAIN')], { maxRetries: 0 })
    const error = await http.request(GET).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NetworkError)
    expect((error as NetworkError).code).toBe('EAI_AGAIN')
    expect((error as NetworkError).cause).toBeInstanceOf(TypeError)
  })

  it('honours Retry-After on 429, with jitter, capped at maxDelayMs', async () => {
    const { http, sleeps } = client([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: 1 },
    ])
    await http.request(GET)
    expect(sleeps).toEqual([1_000])
  })

  it('uses the HTTP-date form of Retry-After', async () => {
    const now = Date.UTC(2026, 8, 13, 12, 0, 0)
    const { http, sleeps } = client(
      [
        { status: 503, headers: { 'retry-after': new Date(now + 3_000).toUTCString() } },
        { status: 200, body: 1 },
      ],
      { now: () => now, maxDelayMs: 10_000, random: () => 0 },
    )
    await http.request(GET)
    expect(sleeps).toEqual([3_000])
  })

  it('does not retry other 4xx or 501', async () => {
    for (const status of [404, 501]) {
      const { http, calls } = client([{ status, body: { error: 'nope' } }])
      await expect(http.request(GET)).rejects.toThrow(HttpError)
      expect(calls).toHaveLength(1)
    }
  })

  it('gives up after maxRetries and throws the last failure', async () => {
    const { http, calls } = client(
      Array.from({ length: 6 }, () => ({ status: 502 })),
      { maxRetries: 5 },
    )
    await expect(http.request(GET)).rejects.toMatchObject({ status: 502 })
    expect(calls).toHaveLength(6)
  })

  it('redacts URLs and body excerpts in HttpError', async () => {
    const { http } = client([{ status: 404, raw: 'denied for Authorization: Bearer abc123def' }])
    const error = (await http
      .request({ ...GET, url: 'https://api.example/x?api_key=zzz999&from=2026-09-01' })
      .catch((e: unknown) => e)) as HttpError
    expect(error.message).not.toContain('abc123def')
    expect(error.message).not.toContain('zzz999')
    expect(error.message).toContain('from=2026-09-01')
  })

  it('rejects a declared content-length over the cap without reading the body', async () => {
    const { http } = client([{ status: 200, raw: 'x', headers: { 'content-length': '999' } }], {
      maxResponseBytes: 50,
    })
    await expect(http.request(GET)).rejects.toThrow(ResponseTooLargeError)
  })

  it('stops reading a chunked body the moment it passes the cap', async () => {
    let pulled = 0
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++
            controller.enqueue(new Uint8Array(40))
          },
        }),
        { status: 200 },
      )
    const { http } = client([endless], { maxResponseBytes: 100 })
    await expect(http.request(GET)).rejects.toThrow(ResponseTooLargeError)
    expect(pulled).toBeLessThan(10)
  })

  it('throws a typed body error for a non-JSON 2xx', async () => {
    const { http } = client([
      { status: 200, raw: '<html>proxy error</html>', headers: { 'content-type': 'text/html' } },
    ])
    const res = await http.request(GET)
    expect(() => res.json()).toThrow(ResponseBodyError)
    expect(() => res.json()).toThrow('text/html')
  })

  it('aborts an in-flight backoff sleep when the signal fires', async () => {
    const { impl } = fakeFetch([{ status: 503 }, { status: 200, body: 1 }])
    const http = createHttpClient({ log, fetch: impl, baseDelayMs: 10_000, maxDelayMs: 10_000 })
    const controller = new AbortController()
    const started = Date.now()
    const pending = http.request({ ...GET, signal: controller.signal })
    setTimeout(() => {
      controller.abort(new Error('shutdown'))
    }, 20)
    await expect(pending).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('drops a request whose signal is already aborted without calling fetch', async () => {
    const { http, calls } = client([{ status: 200, body: 1 }])
    const controller = new AbortController()
    controller.abort(new Error('shutdown'))
    await expect(http.request({ ...GET, signal: controller.signal })).rejects.toThrow('shutdown')
    expect(calls).toHaveLength(0)
  })

  it('fails fast when the next retry would pass the deadline', async () => {
    const { http, calls } = client([{ status: 503 }, { status: 200 }], {
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
    })
    await expect(http.request({ ...GET, deadlineMs: 100 })).rejects.toThrow(DeadlineExceededError)
    expect(calls).toHaveLength(1)
  })

  it('fails fast once the per-credential retry budget is spent', async () => {
    const { http, calls } = client(
      [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 }],
      {
        retryBudget: { maxRetries: 1, windowMs: 60_000 },
      },
    )
    await expect(http.request(GET)).rejects.toThrow(RetryBudgetExhaustedError)
    expect(calls).toHaveLength(2)
  })

  it('logs retries through the per-request logger, correlated and redacted', async () => {
    const lines: string[] = []
    const runLog = createLogger('warn', {
      write: (line: string) => {
        lines.push(line)
      },
    }).child({ syncRunId: 'run-1' })
    const { http } = client([{ status: 503 }, { status: 200, body: 1 }])
    await http.request({ ...GET, url: 'https://api.example/x?token=t0k', log: runLog })
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(entry).toMatchObject({ syncRunId: 'run-1', status: 503, attempt: 0 })
    expect(lines.join('')).not.toContain('t0k')
  })

  it('serialises requests per credential and runs different credentials concurrently', async () => {
    const order: string[] = []
    const gates = new Map<string, () => void>()
    const impl = vi.fn(async (url: string) => {
      const key = url.split('/').pop() ?? ''
      order.push(`start ${key}`)
      await new Promise<void>((resolve) => gates.set(key, resolve))
      order.push(`end ${key}`)
      return new Response('1', { status: 200 })
    })
    const http = createHttpClient({ log, fetch: impl as unknown as typeof fetch })

    const a1 = http.request({ method: 'GET', url: 'https://x/a1', credentialKey: 'a' })
    const a2 = http.request({ method: 'GET', url: 'https://x/a2', credentialKey: 'a' })
    const b1 = http.request({ method: 'GET', url: 'https://x/b1', credentialKey: 'b' })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['start a1', 'start b1'])

    gates.get('a1')?.()
    await a1
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['start a1', 'start b1', 'end a1', 'start a2'])

    gates.get('a2')?.()
    gates.get('b1')?.()
    await Promise.all([a2, b1])
  })

  it('keeps serving a credential queue after a failed request', async () => {
    const { http } = client([{ status: 404 }, { status: 200, body: 'fine' }])
    await expect(http.request(GET)).rejects.toThrow(HttpError)
    expect((await http.request(GET)).json()).toBe('fine')
  })
})
