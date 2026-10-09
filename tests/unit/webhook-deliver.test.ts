import { describe, expect, it } from 'vitest'
import { HttpError } from '../../src/core/http/HttpClient.ts'
import {
  deliverOnce,
  MAX_ATTEMPTS,
  nextAttemptAt,
  RETRY_DELAYS_MS,
  type DeliverDeps,
} from '../../src/modules/webhooks/deliver.ts'
import type { DueDelivery } from '../../src/modules/webhooks/repo.ts'
import { verifyBody } from '../../src/modules/webhooks/sign.ts'
import type { Lookup } from '../../src/modules/webhooks/ssrf.ts'
import { at } from '../helpers.ts'
import { fakeDb, fakeHttp, response, silentLogger, type Answer } from './webhook-fakes.ts'

// One attempt, and what it writes on the delivery row. A client's endpoint failing is an outcome
// here, never an exception: the row carries the attempt count and the next slot on the ladder.

const NOW = new Date('2026-09-14T06:00:00Z')
const SECRET = 'whsec_2f8c1e9a7b4d6f0e3a5c7b9d1f2e4a6c'

const delivery = (over: Partial<DueDelivery> = {}): DueDelivery => ({
  id: '9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1',
  webhookId: '00000000-0000-4000-8000-0000000009b0',
  period: { from: '2026-09-07', to: '2026-09-13' },
  attempt: 1,
  payload: { version: 1, delivery_id: '9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1' },
  url: 'https://client.example.com/hook',
  secret: SECRET,
  ...over,
})

const publicLookup: Lookup = () => Promise.resolve([{ address: '93.184.216.34' }])

/** The row still carries the attempt's claim, so record_attempt lands (one row back). */
const recordLands = (text: string) =>
  text.includes('UPDATE app.webhook_delivery') ? [{ id: delivery().id }] : []

function setup(answer: Answer, lookup: Lookup = publicLookup, respond = recordLands) {
  const db = fakeDb(respond)
  const http = fakeHttp(answer)
  const deps: DeliverDeps = {
    db: db.db,
    http: http.http,
    log: silentLogger(),
    now: () => NOW,
    lookup,
  }
  return { deps, db, http }
}

/** record_attempt's parameters: [id, at, status, nextAttemptAt, code, excerpt, attempt]. */
const attemptParams = (db: ReturnType<typeof fakeDb>) => at(db.matching('webhook_delivery')).params

describe('nextAttemptAt', () => {
  it('walks every rung of the ladder, 12 h included', () => {
    const waits = [1, 2, 3, 4, 5].map((attempts) => {
      const next = nextAttemptAt(attempts, NOW)
      return (next?.getTime() ?? 0) - NOW.getTime()
    })
    expect(waits).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000])
    expect(waits).toEqual([...RETRY_DELAYS_MS])
  })

  it('ends after the sixth attempt', () => {
    expect(MAX_ATTEMPTS).toBe(6)
    expect(nextAttemptAt(MAX_ATTEMPTS, NOW)).toBeNull()
  })
})

describe('deliverOnce', () => {
  it('marks a 200 delivered and signs the exact bytes it sent', async () => {
    const { deps, db, http } = setup(() => response(200, 'ok'))

    const outcome = await deliverOnce(deps, delivery())

    expect(outcome).toMatchObject({ delivered: true, status: 'delivered', responseCode: 200 })
    const sent = at(http.requests)
    expect(sent.bodyText).toBe(JSON.stringify(delivery().payload))
    const timestamp = sent.headers?.['x-timestamp']
    expect(timestamp).toBe(String(NOW.getTime() / 1000))
    // The signature covers the timestamp header too: the client verifies both together.
    expect(verifyBody(timestamp, sent.bodyText ?? '', SECRET, sent.headers?.['x-signature'])).toBe(
      true,
    )
    expect(sent.headers?.['x-delivery-id']).toBe(delivery().id)
    expect(sent.headers?.['x-payload-version']).toBe('1')
    expect(attemptParams(db)[2]).toBe('delivered')
    expect(attemptParams(db)[3]).toBeNull()
  })

  it('records only against the attempt number its claim counted', async () => {
    const { deps, db } = setup(() => response(200))
    const outcome = await deliverOnce(deps, delivery({ attempt: 3 }))
    expect(outcome.recorded).toBe(true)
    expect(attemptParams(db)[6]).toBe(3)
  })

  it('keeps nothing when the row moved on while the attempt was in flight', async () => {
    // A re-send re-queued the row, or another attempt finished it: record_attempt matches nothing.
    const { deps } = setup(
      () => response(200),
      publicLookup,
      () => [],
    )
    const outcome = await deliverOnce(deps, delivery())
    expect(outcome).toMatchObject({ recorded: false, delivered: true })
  })

  it('serialises one webhook against itself', async () => {
    const { deps, http } = setup(() => response(200))
    await deliverOnce(deps, delivery())
    expect(at(http.requests).credentialKey).toBe(`webhook:${delivery().webhookId}`)
  })

  it('schedules the first retry a minute out after a 500', async () => {
    const { deps, db } = setup(() => {
      throw new HttpError(500, 'https://client.example.com/hook', 'upstream boom')
    })

    const outcome = await deliverOnce(deps, delivery())

    expect(outcome).toMatchObject({ delivered: false, status: 'pending', responseCode: 500 })
    expect(outcome.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 60_000)
    expect(attemptParams(db)[2]).toBe('pending')
    expect(String(attemptParams(db)[5])).toContain('upstream boom')
  })

  it('gives up after the sixth attempt', async () => {
    const { deps, db } = setup(() => {
      throw new HttpError(503, 'https://client.example.com/hook', 'still down')
    })

    const outcome = await deliverOnce(deps, delivery({ attempt: MAX_ATTEMPTS }))

    expect(outcome).toMatchObject({ delivered: false, status: 'failed', nextAttemptAt: null })
    expect(attemptParams(db)[2]).toBe('failed')
  })

  it('schedules the last retry 12 h after the fifth failure', async () => {
    const { deps } = setup(() => {
      throw new HttpError(503, 'https://client.example.com/hook', 'still down')
    })

    const outcome = await deliverOnce(deps, delivery({ attempt: MAX_ATTEMPTS - 1 }))

    expect(outcome).toMatchObject({ delivered: false, status: 'pending' })
    expect(outcome.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 12 * 3_600_000)
  })

  it('sends no version header for a body that carries none', async () => {
    const { deps, http } = setup(() => response(200))
    await deliverOnce(deps, delivery({ payload: { delivery_id: 'x' } }))
    expect(at(http.requests).headers).not.toHaveProperty('x-payload-version')
  })

  it('treats a 3xx the client answered with as undelivered', async () => {
    // HttpClient refuses to follow redirects, so a 3xx arrives as a response we do not accept.
    const { deps } = setup(() => response(302, ''))
    const outcome = await deliverOnce(deps, delivery())
    expect(outcome).toMatchObject({ delivered: false, responseCode: 302 })
  })

  it('never sends to a private address and records why', async () => {
    const { deps, http, db } = setup(
      () => response(200),
      () => Promise.resolve([{ address: '169.254.169.254' }]),
    )

    const outcome = await deliverOnce(deps, delivery())

    expect(http.requests).toEqual([])
    expect(outcome).toMatchObject({ delivered: false, status: 'pending', responseCode: null })
    expect(String(attemptParams(db)[5])).toContain('169.254.169.254')
  })

  it('redacts a token the client echoes back', async () => {
    const { deps, db } = setup(() => {
      throw new HttpError(
        401,
        'https://client.example.com/hook',
        'rejected authorization: Bearer sk-live-4d7f9a2b1c3e5f7a',
      )
    })

    await deliverOnce(deps, delivery())

    const excerpt = String(attemptParams(db)[5])
    expect(excerpt).not.toContain('sk-live-4d7f9a2b1c3e5f7a')
    expect(excerpt).toContain('[REDACTED]')
  })

  it('counts a network failure as an attempt', async () => {
    const { deps, db } = setup(() => {
      throw new TypeError('fetch failed')
    })

    const outcome = await deliverOnce(deps, delivery({ attempt: 2 }))

    expect(outcome).toMatchObject({ delivered: false, status: 'pending', responseCode: null })
    expect(outcome.nextAttemptAt?.getTime()).toBe(NOW.getTime() + RETRY_DELAYS_MS[1])
    expect(attemptParams(db)[0]).toBe(delivery().id)
  })
})
