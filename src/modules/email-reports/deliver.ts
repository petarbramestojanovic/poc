import type { Db } from '../../core/db.ts'
import { redact } from '../../core/http/redact.ts'
import type { Logger } from '../../core/log.ts'
import { scrubAddresses } from '../../core/mail/address.ts'
import { MailError } from '../../core/mail/errors.ts'
import type { Mailer } from '../../core/mail/types.ts'
import { MAX_ATTEMPTS, nextAttemptAt } from '../webhooks/deliver.ts'
import { emailFor, idempotencyKeyFor } from './content.ts'
import * as repo from './repo.ts'

// One email for one claimed delivery, and the record of how it went. The ladder is the webhooks'
// (1 m, 5 m, 30 m, 2 h, 12 h, then failed: about 15 h), and so are the claim and the lease: a tick,
// another replica and send-now never send the same row at once, and an outcome lands only while the
// row still carries this attempt's count.
//
// The idempotency key is the delivery id and a hash of the email (content.ts): every retry of an
// unchanged email carries the same key, so an attempt whose answer was lost after the provider took
// the email cannot send it twice. The whole ladder fits in Resend's 24 hours.
//
// A refusal or an outage is an outcome, never an exception: it is recorded with the next rung, and
// the error excerpt holds no address.

const EXCERPT_CHARS = 1024

export interface DeliverDeps {
  db: Db
  mailer: Mailer
  log: Logger
  now?: () => Date
  /** Cancels an attempt in flight at shutdown. */
  signal?: AbortSignal
}

export interface AttemptOutcome {
  /** False when the row moved on while this attempt was in flight, so nothing was recorded. */
  recorded: boolean
  delivered: boolean
  status: repo.DeliveryStatus
  error: string | null
  nextAttemptAt: Date | null
  messageId: string | null
}

/** Sends one claimed delivery and records the attempt. Never throws for a failed send. */
export async function deliverOnce(
  deps: DeliverDeps,
  delivery: repo.DueDelivery,
): Promise<AttemptOutcome> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log.child({ emailReportId: delivery.reportId, deliveryId: delivery.id })
  const at = now()

  const email = emailFor(
    { name: delivery.reportName, timezone: delivery.timezone },
    delivery.recipients,
    delivery.period,
    delivery.document,
    delivery.contentType,
  )
  let sent: { messageId: string } | null = null
  let error: string | null = null
  try {
    sent = await deps.mailer.send(
      { ...email, idempotencyKey: idempotencyKeyFor(delivery.id, email) },
      { log, signal: deps.signal },
    )
  } catch (failure) {
    error = excerptOf(failure)
  }

  const attempts = delivery.attempt // counted when the row was claimed
  const outcome: Omit<AttemptOutcome, 'recorded'> =
    sent === null
      ? {
          delivered: false,
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          error,
          nextAttemptAt: nextAttemptAt(attempts, at),
          messageId: null,
        }
      : {
          delivered: true,
          status: 'delivered',
          error: null,
          nextAttemptAt: null,
          messageId: sent.messageId,
        }

  const recorded = await repo.recordAttempt(deps.db, {
    id: delivery.id,
    attempt: attempts,
    at,
    status: outcome.status,
    nextAttemptAt: outcome.nextAttemptAt,
    error: outcome.error,
    sentTo: outcome.delivered ? delivery.recipients : null,
    provider: deps.mailer.provider,
    providerMessageId: outcome.messageId,
  })

  // Counts, never addresses.
  const fields = {
    status: outcome.status,
    attempt: attempts,
    recipients: delivery.recipients.length,
    provider: deps.mailer.provider,
    ...(outcome.messageId === null ? {} : { messageId: outcome.messageId }),
    ...(outcome.error === null ? {} : { error: outcome.error }),
    ...(outcome.nextAttemptAt === null ? {} : { nextAttemptAt: outcome.nextAttemptAt }),
  }
  if (!recorded) {
    log.warn(
      fields,
      'email report attempt not recorded: the delivery changed while it was in flight',
    )
  } else if (outcome.delivered) {
    log.info(fields, 'email report delivered')
  } else {
    log.warn(fields, 'email report attempt failed')
  }
  return { ...outcome, recorded }
}

/** Why an attempt failed, stored and logged: our own typed message, else redacted; no address. */
function excerptOf(failure: unknown): string {
  const text =
    failure instanceof MailError
      ? `${failure.code}: ${failure.message}`
      : failure instanceof Error
        ? failure.message
        : String(failure)
  return scrubAddresses(redact(text)).slice(0, EXCERPT_CHARS)
}
