import type { Db } from '../../core/db.ts'
import { HttpError, type HttpClient, ResponseTooLargeError } from '../../core/http/HttpClient.ts'
import { REDACTED, redact } from '../../core/http/redact.ts'
import type { Logger } from '../../core/log.ts'
import { BlockedTargetError, ExportUnavailableError } from './errors.ts'
import { exportLink } from './exports.ts'
import { PAYLOAD_VERSION } from './payload.ts'
import * as repo from './repo.ts'
import { signBody } from './sign.ts'
import { assertPublicTarget, type Lookup } from './ssrf.ts'

// One POST to a client's endpoint, and the record of how it went (RFC-002 §15.4). Delivery is
// at-least-once: the delivery row is the idempotency record, its id travels in the header (and
// inside a JSON body), and it does not change between attempts.
//
// What is POSTed depends on the webhook's format (payload.ts):
//   json  the stored document itself, the exact text that was rendered once and signed now;
//   csv   a JSON string holding a fresh signed link to that document (exports.ts) — Funnel's File
//         Import webhook takes links, never files, and fetches the CSV from us afterwards.
// Either way the body is signed like any other, and the client's own key goes in its own header.
//
// Every attempt starts from a claim (repo.claimNextDelivery / claimDelivery), which counts it and
// leases the row, so a tick, another replica and send-now never send the same row at once. The
// outcome lands only while the row still carries that count: a stale attempt can neither turn a
// delivered row back to pending nor overwrite a row a re-send has re-queued.
//
// A client's endpoint being down is not an error of ours: it is an outcome written to the row,
// with the next slot on the ladder. Only the 6th failure ends the delivery as `failed`, about
// 15 h after the first (1 m, 5 m, 30 m, 2 h, 12 h between them).

/**
 * Waits after each failed attempt (RFC-002 §15.4, RFC-004 app.webhook_delivery.next_attempt_at):
 * the first retry a minute after the first failure, the last one 12 h after the fifth.
 */
export const RETRY_DELAYS_MS = [
  60_000, // 1 min
  300_000, // 5 min
  1_800_000, // 30 min
  7_200_000, // 2 h
  43_200_000, // 12 h
] as const

/** Attempts before a delivery is given up on: the first, then one after every rung of the ladder. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1

/**
 * How long a claimed row stays out of every other claimer's reach: far longer than one attempt
 * (a 10 s timeout, behind at most one other attempt to the same webhook), short enough that an
 * attempt that died in flight is retried within minutes.
 */
export const DELIVERY_LEASE_MS = 5 * 60_000

/** The end of the lease for a claim made at `now`. */
export function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + DELIVERY_LEASE_MS)
}

/** Enough of the client's answer to debug with, stored redacted (app.webhook_delivery). */
const EXCERPT_CHARS = 1024

export interface DeliverDeps {
  db: Db
  http: HttpClient
  log: Logger
  /**
   * Where this service is reachable from the internet (config.publicBaseUrl), for the links a csv
   * webhook sends. Without it a csv delivery fails its attempts, and none can be created.
   */
  exportBaseUrl?: string | undefined
  now?: () => Date
  /** Cancels an in-flight attempt at shutdown. */
  signal?: AbortSignal
  /** Injectable for tests; production resolves through DNS. */
  lookup?: Lookup
}

export interface AttemptOutcome {
  /** False when the row moved on while this attempt was in flight, so nothing was recorded. */
  recorded: boolean
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
 * Sends one claimed delivery and records the attempt. Never throws for a refused or failed
 * delivery: the outcome is the return value, already persisted.
 */
export async function deliverOnce(
  deps: DeliverDeps,
  delivery: repo.DueDelivery,
): Promise<AttemptOutcome> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log.child({ deliveryId: delivery.id, webhookId: delivery.webhookId })

  const at = now()
  const result = await attempt(deps, delivery, at, log)

  const attempts = delivery.attempt // counted when the row was claimed
  const outcome: Omit<AttemptOutcome, 'recorded'> = result.delivered
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

  const recorded = await repo.recordAttempt(deps.db, {
    id: delivery.id,
    attempt: attempts,
    at,
    status: outcome.status,
    nextAttemptAt: outcome.nextAttemptAt,
    responseCode: outcome.responseCode,
    excerpt: outcome.excerpt,
  })
  if (!recorded) {
    // Re-queued by a re-send, or finished by another attempt, while this one was in flight. The
    // row already says what happens next; this attempt's outcome is only logged.
    log.warn(
      { status: outcome.status, attempt: attempts },
      'webhook attempt not recorded: the delivery changed while it was in flight',
    )
    return { ...outcome, recorded }
  }

  log.info(
    {
      status: outcome.status,
      attempt: attempts,
      responseCode: outcome.responseCode,
      nextAttemptAt: outcome.nextAttemptAt,
    },
    outcome.delivered ? 'webhook delivered' : 'webhook delivery attempt failed',
  )
  return { ...outcome, recorded }
}

interface AttemptResult {
  delivered: boolean
  responseCode: number | null
  excerpt: string | null
}

async function attempt(
  deps: DeliverDeps,
  delivery: repo.DueDelivery,
  at: Date,
  log: Logger,
): Promise<AttemptResult> {
  try {
    // Re-checked every attempt: DNS moves, and a row can be edited between them.
    await assertPublicTarget(delivery.url, deps.lookup)

    // Built once per attempt: these exact bytes are what we sign and what we send.
    const body = bodyOf(deps, delivery, at)
    // The timestamp is part of what is signed, so it is fixed once and sent exactly as signed.
    const timestamp = String(Math.floor(at.getTime() / 1000))
    const response = await deps.http.request({
      method: 'POST',
      url: delivery.url,
      bodyText: body,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-delivery-id': delivery.id,
        'x-timestamp': timestamp,
        'x-signature': signBody(timestamp, body, delivery.secret),
        ...(delivery.format === 'json' ? { 'x-payload-version': String(PAYLOAD_VERSION) } : {}),
        'user-agent': 'analytics-be-webhooks/2',
        // Last, and checked against ours when it was saved (admin.ts): it can add, never replace.
        ...(delivery.authHeader !== null && delivery.authToken !== null
          ? { [delivery.authHeader]: delivery.authToken }
          : {}),
      },
      // One webhook is never delivered twice at the same time.
      credentialKey: `webhook:${delivery.webhookId}`,
      ...(deps.signal ? { signal: deps.signal } : {}),
      log,
    })
    // HttpClient throws on every status >= 400, so reaching here is a 2xx or a 3xx we refused to
    // follow; only a 2xx counts as delivered.
    const delivered = response.status >= 200 && response.status < 300
    return {
      delivered,
      responseCode: response.status,
      excerpt: excerptOf(response.text, delivery.authToken),
    }
  } catch (error) {
    return failureOf(error, delivery.authToken)
  }
}

/** What one attempt POSTs: the stored JSON document, or a fresh link to the stored CSV. */
function bodyOf(deps: DeliverDeps, delivery: repo.DueDelivery, at: Date): string {
  if (typeof delivery.payload !== 'string') {
    // Rows queued before version 2 hold a JSON object; nothing renders those any more.
    throw new ExportUnavailableError('the delivery holds no rendered document; re-send the period')
  }
  if (delivery.format === 'json') return delivery.payload
  if (deps.exportBaseUrl === undefined) {
    throw new ExportUnavailableError(
      'PUBLIC_BASE_URL is not set, so there is no link to give the client for its CSV',
    )
  }
  return JSON.stringify(exportLink(deps.exportBaseUrl, delivery.id, delivery.secret, at))
}

function failureOf(error: unknown, token: string | null): AttemptResult {
  if (error instanceof HttpError) {
    // HttpError.bodyExcerpt is redacted and truncated already.
    return {
      delivered: false,
      responseCode: error.status,
      excerpt: excerptOf(error.bodyExcerpt, token),
    }
  }
  if (error instanceof BlockedTargetError || error instanceof ExportUnavailableError) {
    return { delivered: false, responseCode: null, excerpt: excerptOf(error.message, token) }
  }
  if (error instanceof ResponseTooLargeError) {
    return { delivered: false, responseCode: null, excerpt: 'response body too large' }
  }
  // Network failures, TLS failures, refused redirects, aborts: the message is ours, but it can
  // quote a URL, so it goes through the same redaction as everything else we store.
  const message = error instanceof Error ? error.message : String(error)
  return { delivered: false, responseCode: null, excerpt: excerptOf(message, token) }
}

/** Redacted like everything we store, and without the client's key should its answer echo it. */
function excerptOf(text: string, token: string | null): string | null {
  const withoutToken = token === null ? text : text.replaceAll(token, REDACTED)
  const trimmed = redact(withoutToken).slice(0, EXCERPT_CHARS)
  return trimmed === '' ? null : trimmed
}
