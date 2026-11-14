import { MailRejectedError } from '../../errors.ts'
import type { MailProvider, MailResult, OutgoingMail } from '../../types.ts'

// Keeps messages in the process and sends nothing: for tests, and for local runs with
// MAIL_PROVIDER=memory. It behaves like Resend where a caller could depend on it: a key seen again
// with the same message returns the first result without keeping a second copy, and with a
// different message is refused.

/** A long-running process with MAIL_PROVIDER=memory must not grow without end. */
const KEEP_LAST = 100

export interface KeptMail {
  readonly mail: OutgoingMail
  readonly messageId: string
}

export interface MemoryMailProvider extends MailProvider {
  /** Oldest first, at most the last 100. */
  readonly sent: readonly KeptMail[]
  /** The next send throws this instead of keeping the message; queued in order. */
  failNext(error: Error): void
  clear(): void
}

export function createMemoryProvider(): MemoryMailProvider {
  const sent: KeptMail[] = []
  const byKey = new Map<string, { fingerprint: string; result: MailResult }>()
  const failures: Error[] = []
  let counter = 0

  return {
    name: 'memory',
    get sent() {
      return sent
    },
    failNext(error) {
      failures.push(error)
    },
    clear() {
      sent.length = 0
      byKey.clear()
      failures.length = 0
    },
    send(mail, ctx) {
      ctx.signal?.throwIfAborted()
      const failure = failures.shift()
      if (failure !== undefined) return Promise.reject(failure)

      const fingerprint = JSON.stringify(mail)
      const known = byKey.get(mail.idempotencyKey)
      if (known !== undefined) {
        if (known.fingerprint === fingerprint) return Promise.resolve(known.result)
        return Promise.reject(
          new MailRejectedError(
            { provider: 'memory', providerStatus: 409, providerCode: 'invalid_idempotent_request' },
            'The idempotency key was used before with a different message',
          ),
        )
      }

      counter += 1
      const result: MailResult = { provider: 'memory', messageId: `memory-${counter}` }
      byKey.set(mail.idempotencyKey, { fingerprint, result })
      sent.push({ mail, messageId: result.messageId })
      if (sent.length > KEEP_LAST) sent.splice(0, sent.length - KEEP_LAST)
      // Keys are kept ten times longer than messages, oldest dropped first (a Map keeps order).
      for (const key of byKey.keys()) {
        if (byKey.size <= KEEP_LAST * 10) break
        byKey.delete(key)
      }
      ctx.log.info(
        { mail: { provider: 'memory', messageId: result.messageId, recipients: mail.to.length } },
        'mail kept in memory, not sent (MAIL_PROVIDER=memory)',
      )
      return Promise.resolve(result)
    },
  }
}
