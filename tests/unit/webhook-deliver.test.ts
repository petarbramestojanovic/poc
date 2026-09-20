import { describe, expect, it } from 'vitest'
import { HttpError } from '../../src/http/HttpClient.ts'
import {
  deliverOnce,
  MAX_ATTEMPTS,
  nextAttemptAt,
  RETRY_DELAYS_MS,
  type DeliverDeps,
} from '../../src/webhooks/deliver.ts'
import type { DueDelivery } from '../../src/webhooks/repo.ts'
import { verifyBody } from '../../src/webhooks/sign.ts'
import type { Lookup } from '../../src/webhooks/ssrf.ts'
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
  attempts: 0,
  payload: { version: 1, delivery_id: '9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1' },
  url: 'https://client.example.com/hook',
  secret: SECRET,
  ...over,
})

const publicLookup: Lookup = () => Promise.resolve([{ address: '93.184.216.34' }])

function setup(answer: Answer, lookup: Lookup = publicLookup) {
  const db = fakeDb()
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

/** The parameters record_attempt was called with: [id, at, status, nextAttemptAt, code, excerpt]. */
const attemptParams = (db: ReturnType<typeof fakeDb>) => at(db.matching('webhook_delivery')).params

describe('nextAttemptAt', () => {
  it('walks the ladder', () => {
    const waits = [1, 2, 3, 4].map((attempts) => {
      const next = nextAttemptAt(attempts, NOW)
      return (next?.getTime() ?? 0) - NOW.getTime()
    })
    expect(waits).toEqual(RETRY_DELAYS_MS.slice(0, 4))
  })

  it('ends after the last attempt', () => {
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
    expect(verifyBody(sent.bodyText ?? '', SECRET, sent.headers?.['x-signature'])).toBe(true)
    expect(sent.headers?.['x-delivery-id']).toBe(delivery().id)
    expect(sent.headers?.['x-timestamp']).toBe(String(NOW.getTime() / 1000))
    expect(attemptParams(db)[2]).toBe('delivered')
    expect(attemptParams(db)[3]).toBeNull()
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

  it('gives up after the fifth attempt', async () => {
    const { deps, db } = setup(() => {
      throw new HttpError(503, 'https://client.example.com/hook', 'still down')
    })

    const outcome = await deliverOnce(deps, delivery({ attempts: MAX_ATTEMPTS - 1 }))

    expect(outcome).toMatchObject({ delivered: false, status: 'failed', nextAttemptAt: null })
    expect(attemptParams(db)[2]).toBe('failed')
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

    const outcome = await deliverOnce(deps, delivery({ attempts: 1 }))

    expect(outcome).toMatchObject({ delivered: false, status: 'pending', responseCode: null })
    expect(outcome.nextAttemptAt?.getTime()).toBe(NOW.getTime() + RETRY_DELAYS_MS[1])
    expect(attemptParams(db)[0]).toBe(delivery().id)
  })
})
