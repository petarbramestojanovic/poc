import type { Logger } from '../log.ts'
import { redact } from './redact.ts'

// One HTTP client for every connector: retries with exponential backoff and jitter on
// 429 / 5xx / network errors, at most one in-flight request per credential, a response
// size cap, and Authorization never reaching the logs.

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  /** JSON-encoded as the request body. */
  body?: unknown
  /** Requests sharing a credential are serialised (per-credential concurrency 1). */
  credentialKey: string
}

export interface HttpResponse {
  status: number
  headers: Headers
  text: string
  json(): unknown
}

export interface HttpClientOptions {
  log: Logger
  fetch?: typeof fetch
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  maxResponseBytes?: number
  /** Injectable for deterministic tests. */
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
}

export class HttpError extends Error {
  override readonly name = 'HttpError'
  readonly status: number
  readonly url: string
  readonly bodyExcerpt: string
  constructor(status: number, url: string, bodyExcerpt: string) {
    super(`HTTP ${status} from ${url}: ${bodyExcerpt}`)
    this.status = status
    this.url = url
    this.bodyExcerpt = bodyExcerpt
  }
}

export class ResponseTooLargeError extends Error {
  override readonly name = 'ResponseTooLargeError'
  constructor(url: string, limit: number) {
    super(`Response from ${url} exceeds ${limit} bytes`)
  }
}

const DEFAULTS = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  timeoutMs: 30_000,
  maxResponseBytes: 10 * 1024 * 1024,
} as const

/**
 * Exponential backoff with "equal jitter": half of the capped exponential delay is fixed,
 * the other half random. attempt 0 → ~base, 1 → ~2·base, 2 → ~4·base …, never above max.
 */
export function backoffDelayMs(
  attempt: number,
  { baseDelayMs, maxDelayMs }: { baseDelayMs: number; maxDelayMs: number },
  random: () => number = Math.random,
): number {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  return Math.round(capped / 2 + random() * (capped / 2))
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const { log } = options
  const doFetch = options.fetch ?? fetch
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULTS.maxResponseBytes
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const queues = new Map<string, Promise<unknown>>()

  async function attemptOnce(req: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers }
    if (req.body !== undefined) headers['content-type'] = 'application/json'

    const init: RequestInit = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (req.body !== undefined) init.body = JSON.stringify(req.body)
    const response = await doFetch(req.url, init)

    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxResponseBytes) throw new ResponseTooLargeError(req.url, maxResponseBytes)
    const text = await response.text()
    if (Buffer.byteLength(text) > maxResponseBytes) {
      throw new ResponseTooLargeError(req.url, maxResponseBytes)
    }

    return {
      status: response.status,
      headers: response.headers,
      text,
      json: () => JSON.parse(text) as unknown,
    }
  }

  async function withRetries(req: HttpRequest): Promise<HttpResponse> {
    const safeReq = redact({ method: req.method, url: req.url, headers: req.headers })
    for (let attempt = 0; ; attempt++) {
      let response: HttpResponse | undefined
      let failure: unknown
      try {
        response = await attemptOnce(req)
        if (!isRetryableStatus(response.status)) {
          if (response.status >= 400) {
            throw new HttpError(response.status, req.url, response.text.slice(0, 200))
          }
          log.debug({ ...safeReq, status: response.status, attempt }, 'http request')
          return response
        }
      } catch (error) {
        if (error instanceof HttpError || error instanceof ResponseTooLargeError) throw error
        failure = error
      }

      if (attempt >= maxRetries) {
        if (response) throw new HttpError(response.status, req.url, response.text.slice(0, 200))
        throw failure
      }

      const delay = Math.min(
        maxDelayMs,
        (response && retryAfterMs(response.headers)) ??
          backoffDelayMs(attempt, { baseDelayMs, maxDelayMs }, random),
      )
      log.warn(
        {
          ...safeReq,
          status: response?.status,
          error: failure instanceof Error ? failure.message : failure,
          attempt,
          delay,
        },
        'http request failed, retrying',
      )
      await sleep(delay)
    }
  }

  function request(req: HttpRequest): Promise<HttpResponse> {
    const previous = queues.get(req.credentialKey) ?? Promise.resolve()
    const run = previous.then(() => withRetries(req))
    queues.set(
      req.credentialKey,
      run.catch(() => undefined),
    )
    return run
  }

  return { request }
}
