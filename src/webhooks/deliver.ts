import type { Db } from '../db.ts'
import { HttpError, type HttpClient, ResponseTooLargeError } from '../http/HttpClient.ts'
import { redact } from '../http/redact.ts'
import type { Logger } from '../log.ts'
import { BlockedTargetError } from './errors.ts'
import * as repo from './repo.ts'
import { signBody } from './sign.ts'
import { assertPublicTarget, type Lookup } from './ssrf.ts'

// One POST to a client's endpoint, and the record of how it went (RFC-002 §15.4). Delivery is
// at-least-once: the delivery row is the idempotency record, its id travels in the header and
// inside the signed body, and it does not change between attempts.
//
// A client's endpoint being down is not an error of ours: it is an outcome written to the row,
// with the next slot on the ladder. Only the 5th failure ends the delivery as `failed`.

/** Waits between attempts (RFC-002 §15.4). The 12 h step is reached only if MAX_ATTEMPTS grows. */
export const RETRY_DELAYS_MS = [
  60_000, // 1 min
  300_000, // 5 min
  1_800_000, // 30 min
  7_200_000, // 2 h
  43_200_000, // 12 h
] as const

/** Attempts before a delivery is given up on. */
export const MAX_ATTEMPTS = 5

/** Enough of the client's answer to debug with, stored redacted (app.webhook_delivery). */
const EXCERPT_CHARS = 1024

export interface DeliverDeps {
  db: Db
  http: HttpClient
  log: Logger
  now?: () => Date
  /** Cancels an in-flight attempt at shutdown. */
  signal?: AbortSignal
  /** Injectable for tests; production resolves through DNS. */
  lookup?: Lookup
}

export interface AttemptOutcome {
  delivered: boolean
  status: 'delivered' | 'pending' | 'failed'
  responseCode: number | null
  excerpt: string | null
  nextAttemptAt: Date | null
}

/** The wait after `attempts` failed attempts, or null when the ladder is exhausted. */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
  const delay = RETRY_DELAYS_MS[attempts - 1]
  if (attempts >= MAX_ATTEMPTS || delay === undefined) return null
  return new Date(now.getTime() + delay)
}

/**
 * Sends one delivery and records the attempt. Never throws for a refused or failed delivery: the
 * outcome is the return value, already persisted.
 */
export async function deliverOnce(
  deps: DeliverDeps,
  delivery: repo.DueDelivery,
): Promise<AttemptOutcome> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log.child({ deliveryId: delivery.id, webhookId: delivery.webhookId })

  // Serialised once: these exact bytes are what we sign and what we send.
  const body = JSON.stringify(delivery.payload)
  const at = now()
  const result = await attempt(deps, delivery, body, at, log)

  const attempts = delivery.attempts + 1
  const outcome: AttemptOutcome = result.delivered
    ? {
        delivered: true,
        status: 'delivered',
        responseCode: result.responseCode,
        excerpt: result.excerpt,
        nextAttemptAt: null,
      }
    : {
        delivered: false,
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        responseCode: result.responseCode,
        excerpt: result.excerpt,
        nextAttemptAt: nextAttemptAt(attempts, at),
      }

  await repo.recordAttempt(deps.db, {
    id: delivery.id,
    at,
    status: outcome.status,
    nextAttemptAt: outcome.nextAttemptAt,
    responseCode: outcome.responseCode,
    excerpt: outcome.excerpt,
  })

  log.info(
    {
      status: outcome.status,
      attempt: attempts,
      responseCode: outcome.responseCode,
      nextAttemptAt: outcome.nextAttemptAt,
    },
    outcome.delivered ? 'webhook delivered' : 'webhook delivery attempt failed',
  )
  return outcome
}

interface AttemptResult {
  delivered: boolean
  responseCode: number | null
  excerpt: string | null
}

async function attempt(
  deps: DeliverDeps,
  delivery: repo.DueDelivery,
  body: string,
  at: Date,
  log: Logger,
): Promise<AttemptResult> {
  try {
    // Re-checked every attempt: DNS moves, and a row can be edited between them.
    await assertPublicTarget(delivery.url, deps.lookup)

    const response = await deps.http.request({
      method: 'POST',
      url: delivery.url,
      bodyText: body,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-delivery-id': delivery.id,
        'x-timestamp': String(Math.floor(at.getTime() / 1000)),
        'x-signature': signBody(body, delivery.secret),
        'user-agent': 'analytics-be-webhooks/1',
      },
      // One webhook is never delivered twice at the same time.
      credentialKey: `webhook:${delivery.webhookId}`,
      ...(deps.signal ? { signal: deps.signal } : {}),
      log,
    })
    // HttpClient throws on every status >= 400, so reaching here is a 2xx or a 3xx we refused to
    // follow; only a 2xx counts as delivered.
    const delivered = response.status >= 200 && response.status < 300
    return { delivered, responseCode: response.status, excerpt: excerptOf(response.text) }
  } catch (error) {
    return failureOf(error)
  }
}

function failureOf(error: unknown): AttemptResult {
  if (error instanceof HttpError) {
    // HttpError.bodyExcerpt is redacted and truncated already.
    return { delivered: false, responseCode: error.status, excerpt: excerptOf(error.bodyExcerpt) }
  }
  if (error instanceof BlockedTargetError) {
    return { delivered: false, responseCode: null, excerpt: excerptOf(error.message) }
  }
  if (error instanceof ResponseTooLargeError) {
    return { delivered: false, responseCode: null, excerpt: 'response body too large' }
  }
  // Network failures, TLS failures, refused redirects, aborts: the message is ours, but it can
  // quote a URL, so it goes through the same redaction as everything else we store.
  const message = error instanceof Error ? error.message : String(error)
  return { delivered: false, responseCode: null, excerpt: excerptOf(message) }
}

function excerptOf(text: string): string | null {
  const trimmed = redact(text).slice(0, EXCERPT_CHARS)
  return trimmed === '' ? null : trimmed
}
