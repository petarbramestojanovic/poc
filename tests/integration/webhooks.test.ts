import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import { createHttpClient, type HttpClient } from '../../src/core/http/HttpClient.ts'
import { createLogger } from '../../src/core/log.ts'
import { DELIVERY_LEASE_MS, leaseUntil, MAX_ATTEMPTS } from '../../src/modules/webhooks/deliver.ts'
import { webhookPayloadSchema } from '../../src/modules/webhooks/payload.ts'
import * as repo from '../../src/modules/webhooks/repo.ts'
import {
  deliverDueDeliveries,
  enqueueDueWebhooks,
  runWebhookTick,
  type WebhookDeps,
} from '../../src/modules/webhooks/scheduler.ts'
import { sendNow, type SendDeps } from '../../src/modules/webhooks/send.ts'
import { verifyBody } from '../../src/modules/webhooks/sign.ts'
import type { Lookup } from '../../src/modules/webhooks/ssrf.ts'
import { at } from '../helpers.ts'
import { SEED } from './db.ts'

// The webhook module against the real schema: Postgres builds the payload, the delivery row is the
// idempotency record, and a stub receiver verifies the signature exactly as a client would. Only
// the socket is faked — `fetch` is injected into the real HttpClient, so headers, body bytes,
// status handling and the SSRF guard are the production ones.

const WEBHOOK = '00000000-0000-4000-8000-0000000009b0'
const SECRET = 'whsec_2f8c1e9a7b4d6f0e3a5c7b9d1f2e4a6c'
const URL_ = 'https://client.example.com/hook'
const MONDAY = new Date('2026-09-14T06:00:00Z') // 08:00 Europe/Zurich
const PERIOD = { from: '2026-09-07', to: '2026-09-13' }

const publicLookup: Lookup = () => Promise.resolve([{ address: '93.184.216.34' }])

interface Received {
  body: string
  headers: Headers
  verified: boolean
}

/** A client endpoint: verifies the signature the way docs/WEBHOOK-PAYLOAD-v1.md tells clients to. */
function stubReceiver(reply: (received: Received) => Response) {
  const received: Received[] = []
  const fetchStub: typeof fetch = (_input, init) => {
    const headers = new Headers(init?.headers)
    // HttpClient always sends the webhook body as a string; anything else is a bug worth failing on.
    const body = typeof init?.body === 'string' ? init.body : ''
    const entry: Received = {
      body,
      headers,
      verified: verifyBody(
        headers.get('x-timestamp') ?? undefined,
        body,
        SECRET,
        headers.get('x-signature') ?? undefined,
      ),
    }
    received.push(entry)
    return Promise.resolve(reply(entry))
  }
  return { received, fetchStub }
}

function httpWith(fetchStub: typeof fetch): HttpClient {
  return createHttpClient({ log: createLogger('silent'), fetch: fetchStub, maxRetries: 0 })
}

describe('webhook scheduling and delivery', () => {
  let db: Db

  const deps = (fetchStub: typeof fetch, now: Date = MONDAY): WebhookDeps => ({
    db,
    http: httpWith(fetchStub),
    log: createLogger('silent'),
    now: () => now,
    lookup: publicLookup,
  })

  const cleanup = async () => {
    await db.query('DELETE FROM app.webhook_delivery WHERE webhook_id = $1', [WEBHOOK])
    await db.query('DELETE FROM app.webhook WHERE id = $1', [WEBHOOK])
    await db.query('DELETE FROM analytics.advanced_analytics WHERE campaign_id = $1', [
      SEED.campaignId,
    ])
    await db.query('DELETE FROM external.sync_state WHERE link_id = $1', [SEED.zeusLinkId])
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    await cleanup()
  })

  beforeEach(async () => {
    await db.query(
      `INSERT INTO analytics.advanced_analytics
         (campaign_id, source, language, campaign_tag, events_date, impressions, in_view, data_source)
       VALUES ($1, 'zeus', 'de', 'mpu_v1', '2026-09-07', 1000, 800, 'sync'),
              ($1, 'zeus', 'de', 'mpu_v1', '2026-09-08', 2000, 1600, 'sync')`,
      [SEED.campaignId],
    )
    await db.query(
      `INSERT INTO external.sync_state (link_id, data_complete_through, last_synced_at)
       VALUES ($1, '2026-09-13', '2026-09-14T02:04:11Z')`,
      [SEED.zeusLinkId],
    )
    await db.query(
      `INSERT INTO app.webhook
         (id, company_id, name, campaign_ids, url, secret, schedule_cron, timezone, next_run_at)
       VALUES ($1, $2, 'weekly', ARRAY[$3::uuid], $4, $5, '0 8 * * 1', 'Europe/Zurich', $6)`,
      [WEBHOOK, SEED.companyId, SEED.campaignId, URL_, SECRET, MONDAY],
    )
  })

  afterEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await db.close()
  })

  const deliveryRow = async () =>
    at(
      await db.query<{
        id: string
        status: string
        attempts: number
        response_code: number | null
        response_excerpt: string | null
        last_attempt_at: Date | null
        next_attempt_at: Date | null
        trigger: string
        payload: unknown
      }>('SELECT * FROM app.webhook_delivery WHERE webhook_id = $1', [WEBHOOK]),
    )

  it('enqueues the closed period with the payload it will send', async () => {
    const { fetchStub } = stubReceiver(() => new Response('ok'))

    const result = await enqueueDueWebhooks(deps(fetchStub))

    expect(result).toEqual({ enqueued: 1, due: 1 })
    const row = await deliveryRow()
    expect(row.status).toBe('pending')
    expect(row.trigger).toBe('schedule')

    const payload = webhookPayloadSchema.parse(row.payload)
    expect(payload.delivery_id).toBe(row.id) // the id is stamped into the body it will sign
    expect(payload.period).toMatchObject({ start: PERIOD.from, end: PERIOD.to })
    expect(at(at(payload.campaigns).sources).totals.impressions).toBe(3000)
  })

  it('moves the schedule to the next occurrence in the webhook timezone', async () => {
    const { fetchStub } = stubReceiver(() => new Response('ok'))
    await enqueueDueWebhooks(deps(fetchStub))

    const [webhook] = await db.query<{ next_run_at: Date }>(
      'SELECT next_run_at FROM app.webhook WHERE id = $1',
      [WEBHOOK],
    )
    expect(webhook?.next_run_at.toISOString()).toBe('2026-09-21T06:00:00.000Z')
  })

  it('never enqueues the same period twice', async () => {
    const { fetchStub } = stubReceiver(() => new Response('ok'))
    await enqueueDueWebhooks(deps(fetchStub))
    // Pretend the schedule came round again without the period changing.
    await db.query('UPDATE app.webhook SET next_run_at = $2 WHERE id = $1', [WEBHOOK, MONDAY])

    const second = await enqueueDueWebhooks(deps(fetchStub))

    expect(second).toEqual({ enqueued: 0, due: 1 })
    const rows = await db.query('SELECT id FROM app.webhook_delivery WHERE webhook_id = $1', [
      WEBHOOK,
    ])
    expect(rows).toHaveLength(1)
  })

  it('delivers a signed body the receiver verifies', async () => {
    const stub = stubReceiver(() => new Response('thanks', { status: 200 }))
    await enqueueDueWebhooks(deps(stub.fetchStub))

    const result = await deliverDueDeliveries(deps(stub.fetchStub))

    expect(result).toEqual({ attempted: 1, delivered: 1 })
    const received = at(stub.received)
    expect(received.verified).toBe(true)
    expect(received.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(received.headers.get('x-payload-version')).toBe('1')

    const row = await deliveryRow()
    expect(row.status).toBe('delivered')
    expect(row.attempts).toBe(1)
    expect(row.response_code).toBe(200)
    expect(received.headers.get('x-delivery-id')).toBe(row.id)
    // The bytes the client verified are the bytes we stored.
    expect(JSON.parse(received.body)).toEqual(row.payload)
  })

  it('schedules the next attempt a minute out after a 500 and keeps the delivery id', async () => {
    const stub = stubReceiver(() => new Response('boom', { status: 500 }))
    await enqueueDueWebhooks(deps(stub.fetchStub))

    await deliverDueDeliveries(deps(stub.fetchStub))
    const first = await deliveryRow()

    expect(first.status).toBe('pending')
    expect(first.attempts).toBe(1)
    expect(first.response_code).toBe(500)
    expect(first.response_excerpt).toContain('boom')
    expect((first.next_attempt_at?.getTime() ?? 0) - MONDAY.getTime()).toBe(60_000)

    // Not due yet: the tick a second later leaves it alone.
    expect(await deliverDueDeliveries(deps(stub.fetchStub))).toEqual({
      attempted: 0,
      delivered: 0,
    })

    // A minute later it is retried, with the same delivery id in the header.
    const later = new Date(MONDAY.getTime() + 61_000)
    await deliverDueDeliveries(deps(stub.fetchStub, later))
    const second = await deliveryRow()

    expect(second.id).toBe(first.id)
    expect(second.attempts).toBe(2)
    expect(stub.received.map((entry) => entry.headers.get('x-delivery-id'))).toEqual([
      first.id,
      first.id,
    ])
  })

  it('gives up after the sixth failure, the last one 12 h after the fifth', async () => {
    const stub = stubReceiver(() => new Response('boom', { status: 503 }))
    await enqueueDueWebhooks(deps(stub.fetchStub))

    let now = MONDAY
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await deliverDueDeliveries(deps(stub.fetchStub, now))
      if (attempt === MAX_ATTEMPTS - 1) {
        // The fifth failure waits the longest rung before the last try.
        const fifth = await deliveryRow()
        expect(fifth.status).toBe('pending')
        expect((fifth.next_attempt_at?.getTime() ?? 0) - now.getTime()).toBe(12 * 3_600_000)
      }
      now = new Date(now.getTime() + 13 * 3_600_000) // past every rung of the ladder
    }

    const row = await deliveryRow()
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(row.status).toBe('failed')
    expect(row.next_attempt_at).toBeNull()
    // A failed delivery is not retried by later ticks.
    expect(await deliverDueDeliveries(deps(stub.fetchStub, now))).toEqual({
      attempted: 0,
      delivered: 0,
    })
  })

  it('refuses a target that resolves to a loopback address, without sending', async () => {
    const stub = stubReceiver(() => new Response('ok'))
    await db.query('UPDATE app.webhook SET url = $2 WHERE id = $1', [
      WEBHOOK,
      'https://127.0.0.1:8443/hook',
    ])
    await enqueueDueWebhooks(deps(stub.fetchStub))

    // The real guard: no injected lookup, an IP literal it refuses outright.
    const result = await deliverDueDeliveries({
      db,
      http: httpWith(stub.fetchStub),
      log: createLogger('silent'),
      now: () => MONDAY,
    })

    expect(result).toEqual({ attempted: 1, delivered: 0 })
    expect(stub.received).toEqual([])
    const row = await deliveryRow()
    expect(row.status).toBe('pending')
    expect(row.response_code).toBeNull()
    expect(row.response_excerpt).toContain('127.0.0.1')
  })

  it('lets exactly one claimer send a delivery, while its attempt is in flight', async () => {
    const stub = stubReceiver(() => new Response('ok'))
    const { promise: gate, resolve: release } = Promise.withResolvers<undefined>()
    let calls = 0
    const held: typeof fetch = async (input, init) => {
      calls += 1
      await gate
      return stub.fetchStub(input, init)
    }
    await enqueueDueWebhooks(deps(stub.fetchStub))

    // The first tick claims the row and its POST stays open.
    const first = deliverDueDeliveries(deps(held))
    await vi.waitFor(() => {
      expect(calls).toBe(1)
    })
    const { id } = await deliveryRow()

    // Meanwhile a second tick (another replica) and send-now's immediate try find nothing to take.
    expect(await deliverDueDeliveries(deps(stub.fetchStub))).toEqual({
      attempted: 0,
      delivered: 0,
    })
    expect(await repo.claimDelivery(db, id, MONDAY, leaseUntil(MONDAY))).toBeUndefined()

    release(undefined)
    expect(await first).toEqual({ attempted: 1, delivered: 1 })
    expect(stub.received).toHaveLength(1)
    expect(await deliveryRow()).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  it('never lets a late outcome overwrite a delivered row or a re-queued one', async () => {
    const stub = stubReceiver(() => new Response('ok'))
    await enqueueDueWebhooks(deps(stub.fetchStub))
    const claimed = await repo.claimNextDelivery(db, MONDAY, leaseUntil(MONDAY))
    if (!claimed) throw new Error('nothing claimed')
    expect(claimed.attempt).toBe(1)
    const outcome = (status: 'delivered' | 'pending', responseCode: number) => ({
      id: claimed.id,
      attempt: claimed.attempt,
      at: MONDAY,
      status,
      nextAttemptAt: null,
      responseCode,
      excerpt: null,
    })

    expect(await repo.recordAttempt(db, outcome('delivered', 200))).toBe(true)
    // Anything arriving after that cannot turn the period back to pending.
    expect(await repo.recordAttempt(db, outcome('pending', 504))).toBe(false)
    expect(await deliveryRow()).toMatchObject({ status: 'delivered', response_code: 200 })

    // A re-send re-queues a failed period while an old attempt is still out: the old one's
    // outcome must not land on the fresh row.
    await db.query(`UPDATE app.webhook_delivery SET status = 'failed' WHERE id = $1`, [claimed.id])
    expect(await repo.requeueDelivery(db, claimed.id, claimed.payload)).toBe(claimed.id)
    expect(await repo.recordAttempt(db, outcome('pending', 504))).toBe(false)
    expect(await deliveryRow()).toMatchObject({
      status: 'pending',
      attempts: 0,
      response_code: null,
      next_attempt_at: null,
    })
  })

  it('claims a delivery again once the lease of an attempt that died in flight runs out', async () => {
    const stub = stubReceiver(() => new Response('ok'))
    await enqueueDueWebhooks(deps(stub.fetchStub))
    // Claimed, then the process dies before the attempt records anything.
    await repo.claimNextDelivery(db, MONDAY, leaseUntil(MONDAY))

    const withinLease = new Date(MONDAY.getTime() + 60_000)
    expect(await deliverDueDeliveries(deps(stub.fetchStub, withinLease))).toEqual({
      attempted: 0,
      delivered: 0,
    })
    const afterLease = new Date(MONDAY.getTime() + DELIVERY_LEASE_MS + 1_000)
    expect(await deliverDueDeliveries(deps(stub.fetchStub, afterLease))).toEqual({
      attempted: 1,
      delivered: 1,
    })
    // Both attempts are counted: the lost one and the one that went out.
    expect(await deliveryRow()).toMatchObject({ status: 'delivered', attempts: 2 })
  })

  it('runs both halves of a tick under the leader lock', async () => {
    const stub = stubReceiver(() => new Response('ok'))

    const result = await runWebhookTick(deps(stub.fetchStub))

    expect(result).toEqual({
      acquired: true,
      enqueue: { enqueued: 1, due: 1 },
      deliver: { attempted: 1, delivered: 1 },
    })
    expect((await deliveryRow()).status).toBe('delivered')
  })
})

describe('POST /webhooks/:id/send-now', () => {
  let db: Db

  const config: Config = {
    databaseUrl: process.env.DATABASE_URL ?? '',
    databaseSsl: 'disable',
    databaseSslCa: undefined,
    adminToken: 'a-long-enough-operator-token-0123456789',
    port: 0,
    logLevel: 'silent',
    trustProxyHops: 0,
    syncSchedulerEnabled: false,
    webhookSchedulerEnabled: false,
  }
  const auth = { authorization: `Bearer ${config.adminToken}` }

  const cleanup = async () => {
    await db.query('DELETE FROM app.webhook_delivery WHERE webhook_id = $1', [WEBHOOK])
    await db.query('DELETE FROM app.webhook WHERE id = $1', [WEBHOOK])
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL ?? '', { max: 4, ssl: 'disable' })
    await cleanup()
  })

  beforeEach(async () => {
    await db.query(
      `INSERT INTO app.webhook
         (id, company_id, name, campaign_ids, url, secret, schedule_cron, timezone, next_run_at)
       VALUES ($1, $2, 'weekly', ARRAY[$3::uuid], $4, $5, '0 8 * * 1', 'Europe/Zurich', $6)`,
      [WEBHOOK, SEED.companyId, SEED.campaignId, URL_, SECRET, MONDAY],
    )
  })

  afterEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await db.close()
  })

  const send = (deps: SendDeps, period?: { from: string; to: string }) =>
    sendNow(deps, { webhookId: WEBHOOK, ...(period ? { period } : {}), deliverNow: false })

  const sendDeps = (fetchStub: typeof fetch): SendDeps => ({
    db,
    http: httpWith(fetchStub),
    log: createLogger('silent'),
    now: () => MONDAY,
    lookup: publicLookup,
  })

  it('answers 202 and delivers the queued period', async () => {
    const stub = stubReceiver(() => new Response('ok'))
    // app.close() closes the pool it was given, so the app gets its own.
    const appDb = createDb(process.env.DATABASE_URL ?? '', { max: 2, ssl: 'disable' })
    const app = buildApp({
      config,
      db: appDb,
      logger: createLogger('silent'),
      webhooks: { ...sendDeps(stub.fetchStub), db: appDb },
    })

    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/${WEBHOOK}/send-now`,
      payload: { period_start: PERIOD.from, period_end: PERIOD.to },
      headers: auth,
    })

    expect(res.statusCode).toBe(202)
    const body = res.json<{ deliveryId: string; periodStart: string; periodEnd: string }>()
    expect(body.periodStart).toBe(PERIOD.from)

    // The immediate attempt runs in the background; app.close() waits for nothing else here, so
    // give the queued delivery its own tick.
    await deliverDueDeliveries(sendDeps(stub.fetchStub))
    const [row] = await db.query<{ id: string; trigger: string; status: string }>(
      'SELECT id, trigger, status FROM app.webhook_delivery WHERE webhook_id = $1',
      [WEBHOOK],
    )
    expect(row?.id).toBe(body.deliveryId)
    expect(row?.trigger).toBe('manual')
    await app.close()
  })

  it('re-queues a failed period under the same delivery id', async () => {
    const stub = stubReceiver(() => new Response('ok'))
    const first = await send(sendDeps(stub.fetchStub), PERIOD)
    await db.query(
      `UPDATE app.webhook_delivery SET status = 'failed', attempts = $2, response_code = 500
        WHERE id = $1`,
      [first.deliveryId, MAX_ATTEMPTS],
    )

    const second = await send(sendDeps(stub.fetchStub), PERIOD)

    expect(second.deliveryId).toBe(first.deliveryId)
    const [row] = await db.query<{
      status: string
      attempts: number
      response_code: number | null
    }>('SELECT status, attempts, response_code FROM app.webhook_delivery WHERE id = $1', [
      first.deliveryId,
    ])
    expect(row).toMatchObject({ status: 'pending', attempts: 0, response_code: null })
  })

  it('refuses to re-send a period that already went out', async () => {
    const stub = stubReceiver(() => new Response('ok'))
    const first = await send(sendDeps(stub.fetchStub), PERIOD)
    await db.query(`UPDATE app.webhook_delivery SET status = 'delivered' WHERE id = $1`, [
      first.deliveryId,
    ])

    await expect(send(sendDeps(stub.fetchStub), PERIOD)).rejects.toMatchObject({
      code: 'already_delivered',
      status: 409,
    })
  })

  it('defaults to the webhook own report window', async () => {
    const stub = stubReceiver(() => new Response('ok'))

    const result = await send(sendDeps(stub.fetchStub))

    expect(result.period).toEqual(PERIOD)
  })
})
