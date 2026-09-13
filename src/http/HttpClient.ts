import { setTimeout as delayFor } from 'node:timers/promises'
import type { Logger } from '../log.ts'
import { redact, redactUrl } from './redact.ts'

// One HTTP client for every connector: retries with exponential backoff and jitter on
// 408 / 429 / transient 5xx / transient network errors, at most one in-flight request per
// credential, a streamed response size cap, no redirects, cancellation, and credentials never
// reaching logs, error messages or stored payloads.

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  /** JSON-encoded as the request body. */
  body?: unknown
  /** Requests sharing a credential are serialised (per-credential concurrency 1). */
  credentialKey: string
  /** Cancels the in-flight attempt, any backoff sleep, and requests still queued. */
  signal?: AbortSignal
  /** Run-scoped logger, so outbound calls are correlated with the sync run that made them. */
  log?: Logger
  /** Wall-clock budget for the request including every retry and sleep. */
  deadlineMs?: number
}

export interface HttpResponse {
  status: number
  headers: Headers
  text: string
  /** Throws ResponseBodyError when the body is not JSON (e.g. a proxy's HTML page with a 200). */
  json(): unknown
}

export interface RetryBudget {
  /** Retries allowed per credential inside `windowMs` before requests fail fast. */
  maxRetries: number
  windowMs: number
}

export interface HttpClientOptions {
  log: Logger
  fetch?: typeof fetch
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  maxResponseBytes?: number
  retryBudget?: RetryBudget
  /** Injectable for deterministic tests. */
  random?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
}

const EXCERPT_CHARS = 200

function excerpt(text: string): string {
  return redact(text.slice(0, EXCERPT_CHARS))
}

export class HttpError extends Error {
  override readonly name = 'HttpError'
  readonly status: number
  /** Redacted. */
  readonly url: string
  /** Redacted, at most 200 characters. */
  readonly bodyExcerpt: string
  constructor(status: number, url: string, body: string) {
    const safeUrl = redactUrl(url)
    const safeBody = excerpt(body)
    super(`HTTP ${status} from ${safeUrl}: ${safeBody}`)
    this.status = status
    this.url = safeUrl
    this.bodyExcerpt = safeBody
  }
}

export class ResponseTooLargeError extends Error {
  override readonly name = 'ResponseTooLargeError'
  constructor(url: string, limit: number) {
    super(`Response from ${redactUrl(url)} exceeds ${limit} bytes`)
  }
}

/** A 2xx whose body is not the JSON the caller asked for. */
export class ResponseBodyError extends Error {
  override readonly name = 'ResponseBodyError'
  readonly status: number
  readonly contentType: string | null
  readonly bodyExcerpt: string
  constructor(
    status: number,
    url: string,
    contentType: string | null,
    body: string,
    cause: unknown,
  ) {
    const safeBody = excerpt(body)
    super(
      `Non-JSON body (HTTP ${status}, ${contentType ?? 'no content-type'}) from ${redactUrl(url)}: ${safeBody}`,
      { cause },
    )
    this.status = status
    this.contentType = contentType
    this.bodyExcerpt = safeBody
  }
}

/** A request that never produced a response. Carries the undici cause code (ECONNRESET, EAI_AGAIN …). */
export class NetworkError extends Error {
  override readonly name = 'NetworkError'
  readonly code: string | undefined
  readonly url: string
  readonly attempt: number
  readonly retryable: boolean
  constructor(
    url: string,
    attempt: number,
    code: string | undefined,
    retryable: boolean,
    cause: unknown,
  ) {
    const safeUrl = redactUrl(url)
    super(`Network error (${code ?? 'unknown'}) calling ${safeUrl} on attempt ${attempt + 1}`, {
      cause,
    })
    this.code = code
    this.url = safeUrl
    this.attempt = attempt
    this.retryable = retryable
  }
}

export class RetryBudgetExhaustedError extends Error {
  override readonly name = 'RetryBudgetExhaustedError'
  constructor(credentialKey: string, budget: RetryBudget) {
    super(
      `Retry budget exhausted for credential ${credentialKey}: ${budget.maxRetries} retries in ${budget.windowMs} ms`,
    )
  }
}

export class DeadlineExceededError extends Error {
  override readonly name = 'DeadlineExceededError'
  constructor(url: string, deadlineMs: number, cause?: unknown) {
    super(`Deadline of ${deadlineMs} ms exceeded calling ${redactUrl(url)}`, { cause })
  }
}

const DEFAULTS = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  timeoutMs: 30_000,
  maxResponseBytes: 10 * 1024 * 1024,
  retryBudget: { maxRetries: 50, windowMs: 10 * 60_000 },
} as const

/** undici / Node socket codes that describe a transient condition worth retrying. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'TIMEOUT',
])

/**
 * Full jitter with a small floor: a random delay across the whole capped exponential range,
 * never below half the base delay. attempt 0 → [base/2, base], 1 → [base/2, 2·base], …
 */
export function backoffDelayMs(
  attempt: number,
  { baseDelayMs, maxDelayMs }: { baseDelayMs: number; maxDelayMs: number },
  random: () => number = Math.random,
): number {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  const floor = Math.min(capped, baseDelayMs / 2)
  return Math.round(floor + random() * (capped - floor))
}

/** 501 Not Implemented and 505 Version Not Supported are permanent, so they are not retried. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501 && status !== 505)
}

/** Both Retry-After forms: delay-seconds and HTTP-date. Non-positive values fall back to backoff. */
export function retryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const value = headers.get('retry-after')?.trim()
  if (value === undefined || value === '') return undefined
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - nowMs
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

function causeCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  if (!response.body) return ''
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ResponseTooLargeError(url, maxBytes)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch = options.fetch ?? fetch
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULTS.maxResponseBytes
  const budget = options.retryBudget ?? DEFAULTS.retryBudget
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      delayFor(ms, undefined, signal ? { signal } : undefined).then(() => undefined))

  const queues = new Map<string, Promise<unknown>>()
  const retriesByCredential = new Map<string, number[]>()

  function takeRetryToken(credentialKey: string): void {
    const cutoff = now() - budget.windowMs
    const recent = (retriesByCredential.get(credentialKey) ?? []).filter((t) => t > cutoff)
    if (recent.length >= budget.maxRetries) {
      retriesByCredential.set(credentialKey, recent)
      throw new RetryBudgetExhaustedError(credentialKey, budget)
    }
    recent.push(now())
    retriesByCredential.set(credentialKey, recent)
  }

  /** Classifies anything fetch or the body read threw into a typed, retry-aware error. */
  function classify(error: unknown, req: HttpRequest, attempt: number): Error {
    if (error instanceof ResponseTooLargeError) return error
    if (req.signal?.aborted) {
      return req.signal.reason instanceof Error ? req.signal.reason : new Error('aborted')
    }
    const name = (error as { name?: unknown } | null)?.name
    if (name === 'TimeoutError') return new NetworkError(req.url, attempt, 'TIMEOUT', true, error)
    const code = causeCode(error)
    if (error instanceof TypeError) {
      return new NetworkError(
        req.url,
        attempt,
        code,
        code !== undefined && TRANSIENT_NETWORK_CODES.has(code),
        error,
      )
    }
    // Programmer errors, TLS verification failures, bugs: terminal on the first attempt.
    return error instanceof Error ? error : new Error(String(error))
  }

  async function attemptOnce(req: HttpRequest, attempt: number): Promise<HttpResponse> {
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers }
    if (req.body !== undefined) headers['content-type'] = 'application/json'

    const timeout = AbortSignal.timeout(timeoutMs)
    const init: RequestInit = {
      method: req.method,
      headers,
      signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
      // A redirect would silently turn the NEXD POST into a body-less GET: fail loudly instead.
      redirect: 'error',
    }
    if (req.body !== undefined) init.body = JSON.stringify(req.body)

    let response: Response
    let text: string
    try {
      response = await doFetch(req.url, init)
      const declared = response.headers.get('content-length')
      if (declared !== null && Number(declared) > maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw new ResponseTooLargeError(req.url, maxResponseBytes)
      }
      text = await readCapped(response, maxResponseBytes, req.url)
    } catch (error) {
      throw classify(error, req, attempt)
    }

    const { status } = response
    const contentType = response.headers.get('content-type')
    return {
      status,
      headers: response.headers,
      text,
      json: () => {
        try {
          return JSON.parse(text) as unknown
        } catch (cause) {
          throw new ResponseBodyError(status, req.url, contentType, text, cause)
        }
      },
    }
  }

  async function withRetries(req: HttpRequest): Promise<HttpResponse> {
    const log = req.log ?? options.log
    const safeReq = { method: req.method, url: redactUrl(req.url) }
    const started = now()

    for (let attempt = 0; ; attempt++) {
      req.signal?.throwIfAborted()
      const attemptStarted = now()
      let response: HttpResponse | undefined
      let failure: NetworkError | undefined
      try {
        response = await attemptOnce(req, attempt)
        if (!isRetryableStatus(response.status)) {
          if (response.status >= 400) throw new HttpError(response.status, req.url, response.text)
          log.debug(
            { ...safeReq, status: response.status, attempt, durationMs: now() - attemptStarted },
            'http request',
          )
          return response
        }
      } catch (error) {
        if (!(error instanceof NetworkError && error.retryable)) throw error
        failure = error
      }

      if (attempt >= maxRetries) {
        if (response) throw new HttpError(response.status, req.url, response.text)
        throw failure ?? new Error('retry loop ended without a result')
      }

      const requested = response ? retryAfterMs(response.headers, now()) : undefined
      const jitter =
        requested === undefined ? 0 : Math.round(random() * Math.min(1_000, requested / 10))
      const delay = Math.min(
        maxDelayMs,
        requested === undefined
          ? backoffDelayMs(attempt, { baseDelayMs, maxDelayMs }, random)
          : requested + jitter,
      )
      if (req.deadlineMs !== undefined && now() - started + delay > req.deadlineMs) {
        throw new DeadlineExceededError(req.url, req.deadlineMs, failure)
      }
      takeRetryToken(req.credentialKey)

      log.warn(
        {
          ...safeReq,
          status: response?.status,
          err: failure,
          code: failure?.code,
          attempt,
          delay,
          durationMs: now() - attemptStarted,
        },
        'http request failed, retrying',
      )
      await sleep(delay, req.signal)
    }
  }

  function request(req: HttpRequest): Promise<HttpResponse> {
    const previous = queues.get(req.credentialKey) ?? Promise.resolve()
    const run = previous.then(() => {
      // Dropped while queued behind another request on the same credential.
      req.signal?.throwIfAborted()
      return withRetries(req)
    })
    queues.set(
      req.credentialKey,
      run.catch(() => undefined),
    )
    return run
  }

  return { request }
}
