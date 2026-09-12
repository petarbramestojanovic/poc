import { describe, expect, it, vi } from 'vitest'
import {
  backoffDelayMs,
  createHttpClient,
  HttpError,
  ResponseTooLargeError,
} from '../../src/http/HttpClient.ts'
import { createLogger } from '../../src/log.ts'

const log = createLogger('silent')

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('no reply scripted')
    if (reply instanceof Error) throw reply
    const body = reply.body === undefined ? '' : JSON.stringify(reply.body)
    return new Response(
      body,
      reply.headers ? { status: reply.status, headers: reply.headers } : { status: reply.status },
    )
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

function client(replies: Reply[], extra: Record<string, unknown> = {}) {
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
  it('doubles per attempt with equal jitter and caps at maxDelayMs', () => {
    const opts = { baseDelayMs: 500, maxDelayMs: 30_000 }
    expect([0, 1, 2, 3, 4].map((a) => backoffDelayMs(a, opts, () => 0))).toEqual([
      250, 500, 1_000, 2_000, 4_000,
    ])
    expect([0, 1, 2, 3, 4].map((a) => backoffDelayMs(a, opts, () => 1))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000,
    ])
    expect(backoffDelayMs(10, opts, () => 1)).toBe(30_000)
    expect(backoffDelayMs(10, opts, () => 0)).toBe(15_000)
  })
})

describe('HttpClient', () => {
  it('returns parsed JSON on 2xx and sends JSON bodies with a bearer header', async () => {
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
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer k',
      'content-type': 'application/json',
    })
  })

  it('retries 5xx and network errors with the backoff schedule', async () => {
    const { http, sleeps, calls } = client([
      { status: 503 },
      new Error('ECONNRESET'),
      { status: 500 },
      { status: 200, body: 1 },
    ])
    const res = await http.request(GET)
    expect(res.json()).toBe(1)
    expect(calls).toHaveLength(4)
    expect(sleeps).toEqual([75, 150, 300])
  })

  it('honours Retry-After on 429', async () => {
    const { http, sleeps } = client([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: 1 },
    ])
    await http.request(GET)
    expect(sleeps).toEqual([1_000]) // 2 s requested, capped at maxDelayMs
  })

  it('does not retry other 4xx', async () => {
    const { http, calls } = client([{ status: 404, body: { error: 'nope' } }])
    await expect(http.request(GET)).rejects.toThrow(HttpError)
    expect(calls).toHaveLength(1)
  })

  it('gives up after maxRetries and throws the last failure', async () => {
    const { http, calls } = client(
      Array.from({ length: 6 }, () => ({ status: 502 })),
      {
        maxRetries: 5,
      },
    )
    await expect(http.request(GET)).rejects.toMatchObject({ status: 502 })
    expect(calls).toHaveLength(6)
  })

  it('rejects responses over the size cap', async () => {
    const { http } = client([{ status: 200, body: 'x'.repeat(100) }], { maxResponseBytes: 50 })
    await expect(http.request(GET)).rejects.toThrow(ResponseTooLargeError)
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
