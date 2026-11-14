import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import type { Config } from '../../src/core/config.ts'
import { createDb, type Db } from '../../src/core/db.ts'
import { createLogger } from '../../src/core/log.ts'
import { MailRejectedError, MailUnavailableError } from '../../src/core/mail/errors.ts'
import { mailerFor } from '../../src/core/mail/mailer.ts'
import {
  createMemoryProvider,
  type MemoryMailProvider,
} from '../../src/core/mail/providers/memory/provider.ts'
import type { Mailer, MailMessage } from '../../src/core/mail/types.ts'
import { createRunTracker } from '../../src/modules/sync/engine.ts'
import { MAX_ATTEMPTS } from '../../src/modules/webhooks/deliver.ts'
import { buildReport, renderReport } from '../../src/modules/webhooks/build.ts'
import { readStoredFields } from '../../src/modules/webhooks/fields.ts'
import {
  deliverDueEmails,
  enqueueDueReports,
  runEmailReportTick,
  type EmailReportDeps,
} from '../../src/modules/email-reports/scheduler.ts'
import { sendNow, type EmailReportServiceDeps } from '../../src/modules/email-reports/send.ts'
import { at } from '../helpers.ts'
import { SEED } from './db.ts'

// Email reports against the real schema, with the memory mail provider: the tick enqueues a
// period with the file it will attach, waits for the sync like a webhook, and the delivery row is
// the idempotency record across the retry ladder. The mailer in front of the provider is the
// production one, so every message passes its checks.

const REPORT = '00000000-0000-4000-8000-0000000009e1'
const OTHER_COMPANY = '00000000-0000-4000-8000-0000000009e2'
const OTHER_CAMPAIGN = '00000000-0000-4000-8000-0000000009e3'
const RECIPIENTS = ['anna.berger@example.com', 'ben.meier@example.com']
const NOW = new Date('2026-09-14T01:00:00Z') // 03:00 Europe/Zurich, when the report is due
const NOON = new Date('2026-09-14T10:00:00Z') // 12:00 Europe/Zurich
const PERIOD = { from: '2026-09-13', to: '2026-09-13' }

const FIELDS = {
  source: 'zeus',
  columns: [
    { name: 'Ad Type', value: 'Dynamic Ad' },
    { name: 'Impressions', formula: 'impressions', decimals: 0 },
  ],
}
const SETTINGS = { format: 'csv', fields: FIELDS }

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
  emailReportSchedulerEnabled: false,
}
const auth = { authorization: `Bearer ${config.adminToken}` }

/** The seeded campaign: Zeus numbers on the 12th and the 13th. */
async function seedNumbers(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO analytics.advanced_analytics
       (campaign_id, source, language, campaign_tag, events_date, impressions, in_view, data_source)
     VALUES ($1, 'zeus', 'de', 'mpu_v1', '2026-09-12', 500, 400, 'sync'),
            ($1, 'zeus', 'de', 'mpu_v1', '2026-09-13', 1000, 800, 'sync')`,
    [SEED.campaignId],
  )
}

/** A daily csv report for the seeded campaign at 03:00 Zurich, due now. */
async function insertReport(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO app.email_report
       (id, company_id, name, campaign_ids, recipients, schedule_cron, timezone, report_window,
        settings, next_run_at)
     VALUES ($1, $2, 'Dev Always-on', ARRAY[$3::uuid], $4, '0 3 * * *', 'Europe/Zurich',
             'previous_day', $5, $6)`,
    [REPORT, SEED.companyId, SEED.campaignId, RECIPIENTS, JSON.stringify(SETTINGS), NOW],
  )
}

/** A mailer that remembers every message it was asked to send, sent or not. */
function recording(inner: Mailer): Mailer & { asked: MailMessage[] } {
  const asked: MailMessage[] = []
  return {
    provider: inner.provider,
    asked,
    send(message, ctx) {
      asked.push(message)
      return inner.send(message, ctx)
    },
  }
}

interface DeliveryRow {
  id: string
  trigger: string
  status: string
  attempts: number
  next_attempt_at: Date | null
  last_attempt_at: Date | null
  document: string
  content_type: string
  sent_to: string[] | null
  provider: string | null
  provider_message_id: string | null
  error_excerpt: string | null
}

describe('email reports', () => {
  let db: Db
  let provider: MemoryMailProvider
  let mailer: ReturnType<typeof recording>
  const lines: string[] = []
  const log = createLogger('debug', { write: (line: string) => void lines.push(line) })

  const deps = (now: Date = NOW): EmailReportDeps & EmailReportServiceDeps => ({
    db,
    mailer,
    log,
    now: () => now,
  })

  const cleanup = async () => {
    await db.query('DELETE FROM app.email_report WHERE id = $1 OR company_id = $2', [
      REPORT,
      OTHER_COMPANY,
    ])
    await db.query('DELETE FROM app.email_report WHERE company_id = $1', [SEED.companyId])
    await db.query('DELETE FROM app.campaign WHERE id = $1', [OTHER_CAMPAIGN])
    await db.query('DELETE FROM app.company WHERE id = $1', [OTHER_COMPANY])
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
    provider = createMemoryProvider()
    mailer = recording(mailerFor(provider, { from: 'Klea Analytics <reports@example.com>' }))
    lines.length = 0
    await seedNumbers(db)
    // The nightly sync wrote the 13th: the report need not wait.
    await db.query(
      `INSERT INTO external.sync_state (link_id, data_complete_through, last_synced_at)
       VALUES ($1, '2026-09-13', '2026-09-14T00:34:11Z')`,
      [SEED.zeusLinkId],
    )
    await insertReport(db)
  })

  afterEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await db.close()
  })

  const deliveries = () =>
    db.query<DeliveryRow>(
      'SELECT * FROM app.email_report_delivery WHERE email_report_id = $1 ORDER BY created_at',
      [REPORT],
    )

  const nextRun = async () =>
    at(
      await db.query<{ next_run_at: Date }>(
        'SELECT next_run_at FROM app.email_report WHERE id = $1',
        [REPORT],
      ),
    ).next_run_at.toISOString()

  describe('the tick', () => {
    it('enqueues the closed day with the file it will attach, and moves the schedule on', async () => {
      expect(await enqueueDueReports(deps())).toEqual({ enqueued: 1, due: 1, waiting: 0, empty: 0 })

      const row = at(await deliveries())
      expect(row).toMatchObject({ trigger: 'schedule', status: 'pending', attempts: 0 })
      expect(row.content_type).toBe('text/csv; charset=utf-8')
      expect(row.document).toBe(
        'Date,Campaign,Ad Type,Impressions\r\n2026-09-13,DEV0001 Dev Campaign,Dynamic Ad,1000\r\n',
      )
      expect(await nextRun()).toBe('2026-09-15T01:00:00.000Z')
    })

    it('attaches the same file a webhook with the same columns sends', async () => {
      await enqueueDueReports(deps())
      const row = at(await deliveries())

      const target = {
        id: REPORT,
        companyId: SEED.companyId,
        campaignIds: [SEED.campaignId],
        timezone: 'Europe/Zurich',
        frequency: 'daily' as const,
        format: 'csv' as const,
      }
      const fields = readStoredFields(FIELDS)
      const webhookFile = renderReport(
        target,
        PERIOD,
        await buildReport(db, target, PERIOD, fields),
        row.id,
        NOW,
      )
      expect(row.document).toBe(webhookFile)
    })

    it('waits for a sync that has not written the day, then sends at noon', async () => {
      await db.query(
        `UPDATE external.sync_state SET data_complete_through = '2026-09-12' WHERE link_id = $1`,
        [SEED.zeusLinkId],
      )
      expect(await enqueueDueReports(deps())).toMatchObject({ enqueued: 0, waiting: 1 })
      expect(await deliveries()).toEqual([])
      expect(await nextRun()).toBe(NOW.toISOString())

      expect(await enqueueDueReports(deps(NOON))).toMatchObject({ enqueued: 1, waiting: 0 })
    })

    it('sends nothing for a day without numbers, and moves the schedule on', async () => {
      await db.query('DELETE FROM analytics.advanced_analytics WHERE campaign_id = $1', [
        SEED.campaignId,
      ])
      expect(await enqueueDueReports(deps())).toEqual({ enqueued: 0, due: 1, waiting: 0, empty: 1 })
      expect(await deliveries()).toEqual([])
      expect(await nextRun()).toBe('2026-09-15T01:00:00.000Z')
    })

    it('queues a period once, also when two ticks run at the same time', async () => {
      const results = await Promise.all([enqueueDueReports(deps()), enqueueDueReports(deps())])
      expect(results.map((result) => result.enqueued).sort()).toEqual([0, 1])
      expect(await deliveries()).toHaveLength(1)

      // The schedule coming round again for the same period inserts nothing either.
      await db.query('UPDATE app.email_report SET next_run_at = $2 WHERE id = $1', [REPORT, NOW])
      expect(await enqueueDueReports(deps())).toMatchObject({ enqueued: 0, due: 1 })
      expect(await deliveries()).toHaveLength(1)
    })

    it('postpones a report whose settings were broken by hand, and goes on with the others', async () => {
      await db.query(`UPDATE app.email_report SET settings = '{"format": "pdf"}' WHERE id = $1`, [
        REPORT,
      ])
      expect(await enqueueDueReports(deps())).toMatchObject({ enqueued: 0, due: 1 })
      expect(await nextRun()).toBe(new Date(NOW.getTime() + 3_600_000).toISOString())
    })

    it('runs both halves under the leader lock', async () => {
      const result = await runEmailReportTick(deps())
      expect(result).toMatchObject({
        acquired: true,
        enqueue: { enqueued: 1 },
        deliver: { attempted: 1, delivered: 1 },
      })
    })
  })

  describe('delivering', () => {
    it('sends one email to all recipients with the stored file attached, and records it', async () => {
      await enqueueDueReports(deps())
      expect(await deliverDueEmails(deps())).toEqual({ attempted: 1, delivered: 1 })

      expect(provider.sent).toHaveLength(1)
      const mail = at(provider.sent).mail
      const row = at(await deliveries())
      expect(mail.from).toBe('Klea Analytics <reports@example.com>')
      expect(mail.to).toEqual(RECIPIENTS)
      expect(mail.subject).toBe('Dev Always-on, 2026-09-13')
      expect(mail.attachments).toEqual([
        {
          filename: 'dev-always-on_2026-09-13.csv',
          contentType: 'text/csv; charset=utf-8',
          content: row.document,
        },
      ])
      expect(row).toMatchObject({
        status: 'delivered',
        attempts: 1,
        sent_to: RECIPIENTS,
        provider: 'memory',
        provider_message_id: at(provider.sent).messageId,
        error_excerpt: null,
        next_attempt_at: null,
      })
      expect(row.last_attempt_at?.toISOString()).toBe(NOW.toISOString())
    })

    it('retries a minute later with the same idempotency key, and records no address', async () => {
      await enqueueDueReports(deps())
      provider.failNext(
        new MailRejectedError(
          { provider: 'memory', providerStatus: 403, providerCode: 'validation_error' },
          'You can only send testing emails to your own email address (owner@example.com).',
        ),
      )
      await deliverDueEmails(deps())

      const failed = at(await deliveries())
      expect(failed).toMatchObject({ status: 'pending', attempts: 1, sent_to: null })
      expect(failed.next_attempt_at?.toISOString()).toBe(
        new Date(NOW.getTime() + 60_000).toISOString(),
      )
      expect(failed.error_excerpt).toBe(
        'mail_rejected: You can only send testing emails to your own email address ([address]).',
      )

      // Not due yet; then due, and the same email with the same key goes out.
      expect(await deliverDueEmails(deps())).toEqual({ attempted: 0, delivered: 0 })
      expect(await deliverDueEmails(deps(new Date(NOW.getTime() + 60_000)))).toEqual({
        attempted: 1,
        delivered: 1,
      })
      const [first, second] = mailer.asked
      expect(second?.idempotencyKey).toBe(first?.idempotencyKey)
      expect(first?.idempotencyKey.startsWith(`${failed.id}:`)).toBe(true)
    })

    it('gives up after the sixth failure, the last one 12 h after the fifth', async () => {
      await enqueueDueReports(deps())
      let clock = NOW
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        provider.failNext(new MailUnavailableError({ provider: 'memory' }, 'down'))
        expect(await deliverDueEmails(deps(clock))).toEqual({ attempted: 1, delivered: 0 })
        const row = at(await deliveries())
        if (attempt < MAX_ATTEMPTS) clock = row.next_attempt_at ?? clock
      }
      const row = at(await deliveries())
      expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, next_attempt_at: null })
      expect(row.last_attempt_at?.getTime()).toBe(
        NOW.getTime() + (60 + 300 + 1800 + 7200 + 43200) * 1000,
      )
      expect(provider.sent).toHaveLength(0)
    })

    it('lets exactly one of two concurrent senders send a delivery', async () => {
      await enqueueDueReports(deps())
      const results = await Promise.all([deliverDueEmails(deps()), deliverDueEmails(deps())])
      expect(results.map((result) => result.attempted).sort()).toEqual([0, 1])
      expect(provider.sent).toHaveLength(1)
    })

    it('sends to the recipients the report has at the attempt', async () => {
      await enqueueDueReports(deps())
      await db.query(
        `UPDATE app.email_report SET recipients = '{carla@example.com}' WHERE id = $1`,
        [REPORT],
      )
      await deliverDueEmails(deps())
      expect(at(provider.sent).mail.to).toEqual(['carla@example.com'])
      expect(at(await deliveries()).sent_to).toEqual(['carla@example.com'])
    })

    it('holds a disabled report’s deliveries back', async () => {
      await enqueueDueReports(deps())
      await db.query('UPDATE app.email_report SET enabled = false WHERE id = $1', [REPORT])
      expect(await deliverDueEmails(deps())).toEqual({ attempted: 0, delivered: 0 })
    })

    it('never writes a recipient address to the log', async () => {
      await enqueueDueReports(deps())
      provider.failNext(new MailUnavailableError({ provider: 'memory' }, 'down'))
      await deliverDueEmails(deps())
      await deliverDueEmails(deps(new Date(NOW.getTime() + 60_000)))
      const text = lines.join('\n')
      expect(text).toContain('email report delivered')
      for (const address of RECIPIENTS) expect(text).not.toContain(address)
      expect(text).not.toContain('@example.com')
    })
  })

  describe('send-now', () => {
    const send = (period = PERIOD) =>
      sendNow(deps(), { reportId: REPORT, period, deliverNow: false })

    it('re-queues a failed period under the same id, with a new key for the rebuilt file', async () => {
      await enqueueDueReports(deps())
      await deliverDueEmails(deps()) // delivered, key 1
      await db.query(
        `UPDATE app.email_report_delivery SET status = 'failed', attempts = 6 WHERE email_report_id = $1`,
        [REPORT],
      )
      // The numbers moved on since.
      await db.query(
        `UPDATE analytics.advanced_analytics SET impressions = 1200
          WHERE campaign_id = $1 AND events_date = '2026-09-13'`,
        [SEED.campaignId],
      )

      const { deliveryId } = await send()
      const rows = await deliveries()
      expect(rows).toHaveLength(1)
      expect(at(rows)).toMatchObject({ id: deliveryId, status: 'pending', attempts: 0 })
      expect(at(rows).document).toContain('Dynamic Ad,1200')

      await deliverDueEmails(deps())
      const [first, second] = mailer.asked
      expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey)
      expect(second?.idempotencyKey.startsWith(`${deliveryId}:`)).toBe(true)
    })

    it('sends a delivered period again as a new delivery, and keeps the first', async () => {
      await enqueueDueReports(deps())
      await deliverDueEmails(deps())
      const { deliveryId } = await send()

      const rows = await deliveries()
      expect(rows.map((row) => [row.trigger, row.status])).toEqual([
        ['schedule', 'delivered'],
        ['manual', 'pending'],
      ])
      expect(at(rows, 1).id).toBe(deliveryId)
      await deliverDueEmails(deps())
      expect(provider.sent).toHaveLength(2)
    })

    it('refuses a period without numbers, and a disabled report', async () => {
      await expect(send({ from: '2026-09-01', to: '2026-09-02' })).rejects.toMatchObject({
        code: 'empty_period',
        status: 409,
      })
      await db.query('UPDATE app.email_report SET enabled = false WHERE id = $1', [REPORT])
      await expect(send()).rejects.toMatchObject({ code: 'email_report_disabled', status: 409 })
    })

    it('refuses while email is off', async () => {
      await expect(
        sendNow({ db, log, mailer: undefined }, { reportId: REPORT, period: PERIOD }),
      ).rejects.toMatchObject({ code: 'mail_not_configured', status: 422 })
    })
  })

  describe('routes', () => {
    let appDb: Db
    const app = (withMailer = true) =>
      buildApp({
        config,
        db: appDb,
        logger: createLogger('silent'),
        emailReports: { db: appDb, mailer: withMailer ? mailer : undefined, log, now: () => NOW },
      })

    beforeEach(() => {
      // app.close() closes the pool it was given, so every app gets its own.
      appDb = createDb(process.env.DATABASE_URL ?? '', { max: 2, ssl: 'disable' })
    })

    const createBody = {
      companyId: SEED.companyId,
      name: 'Dev weekly',
      recipients: [' anna.berger@example.com', 'ben.meier@example.com'],
      campaignIds: [SEED.campaignId],
      frequency: 'weekly',
      settings: SETTINGS,
    }

    it('needs the admin token', async () => {
      const server = app()
      const res = await server.inject({ method: 'GET', url: '/email-reports' })
      expect(res.statusCode).toBe(401)
      await server.close()
    })

    it('creates a report, lists it with its recipients and last email, and changes it', async () => {
      const server = app()
      const created = await server.inject({
        method: 'POST',
        url: '/email-reports',
        headers: auth,
        payload: createBody,
      })
      expect(created.statusCode).toBe(201)
      const { report } = created.json<{
        report: {
          id: string
          recipients: string[]
          scheduleCron: string
          nextRunAt: string
          settings: unknown
        }
      }>()
      expect(report.recipients).toEqual(['anna.berger@example.com', 'ben.meier@example.com'])
      expect(report.scheduleCron).toBe('0 5 * * 1')
      // Now is Monday 03:00 Zurich, so the first run is the same Monday at 05:00.
      expect(report.nextRunAt).toBe('2026-09-14T03:00:00.000Z')
      // Stored in the row-set form, defaults filled in.
      expect(report.settings).toMatchObject({
        format: 'csv',
        fields: { columns: ['Ad Type', 'Impressions'] },
      })

      const patched = await server.inject({
        method: 'PATCH',
        url: `/email-reports/${report.id}`,
        headers: auth,
        payload: { recipients: ['carla@example.com'], scheduleCron: '0 3 * * 1', enabled: false },
      })
      expect(patched.statusCode).toBe(200)
      expect(
        patched.json<{ report: { recipients: string[]; enabled: boolean } }>().report,
      ).toMatchObject({
        recipients: ['carla@example.com'],
        enabled: false,
      })

      const listed = await server.inject({ method: 'GET', url: '/email-reports', headers: auth })
      const mine = listed
        .json<{ id: string; lastDelivery: unknown }[]>()
        .find((entry) => entry.id === report.id)
      expect(mine?.lastDelivery).toBeNull()
      await server.close()
    })

    it.each([
      ['a recipient that is not an address', { recipients: ['anna'] }, 'recipients[0]'],
      ['a recipient listed twice', { recipients: ['a@example.com', 'A@example.com'] }, 'twice'],
      ['a cron that never fires', { scheduleCron: 'every monday' }, 'scheduleCron'],
      [
        'a formula on a metric the source does not measure',
        {
          settings: {
            fields: { source: 'zeus', columns: [{ name: 'Dwell', formula: 'dwell_avg_ms' }] },
          },
        },
        'zeus does not measure dwell_avg_ms',
      ],
      ['an unknown format', { settings: { format: 'pdf', fields: FIELDS } }, 'format'],
    ])('refuses %s with 422', async (_name, change, text) => {
      const server = app()
      const res = await server.inject({
        method: 'POST',
        url: '/email-reports',
        headers: auth,
        payload: { ...createBody, ...change },
      })
      expect(res.statusCode).toBe(422)
      expect(res.body).toContain(text)
      await server.close()
    })

    it('refuses a campaign of another company', async () => {
      await db.query(`INSERT INTO app.company (id, name) VALUES ($1, 'Other company')`, [
        OTHER_COMPANY,
      ])
      await db.query(
        `INSERT INTO app.campaign (id, company_id, name, primary_source) VALUES ($1, $2, 'Other', 'zeus')`,
        [OTHER_CAMPAIGN, OTHER_COMPANY],
      )
      const server = app()
      const res = await server.inject({
        method: 'POST',
        url: '/email-reports',
        headers: auth,
        payload: { ...createBody, campaignIds: [OTHER_CAMPAIGN] },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json<{ error: string }>().error).toBe('invalid_email_report')
      await server.close()
    })

    it('refuses to create a report while email is off, but previews one', async () => {
      const server = app(false)
      const created = await server.inject({
        method: 'POST',
        url: '/email-reports',
        headers: auth,
        payload: createBody,
      })
      expect(created.statusCode).toBe(422)
      expect(created.json<{ error: string }>().error).toBe('mail_not_configured')

      const preview = await server.inject({
        method: 'POST',
        url: `/email-reports/${REPORT}/preview`,
        headers: auth,
        payload: { period_start: PERIOD.from, period_end: PERIOD.to },
      })
      expect(preview.statusCode).toBe(200)
      expect(preview.json()).toEqual({
        periodStart: PERIOD.from,
        periodEnd: PERIOD.to,
        rowCount: 1,
        recipients: RECIPIENTS,
        subject: 'Dev Always-on, 2026-09-13',
        text: 'Attached is the report "Dev Always-on" for 2026-09-13 (Europe/Zurich).\n\nThis email is sent automatically.',
        attachment: {
          filename: 'dev-always-on_2026-09-13.csv',
          contentType: 'text/csv; charset=utf-8',
        },
        document:
          'Date,Campaign,Ad Type,Impressions\r\n2026-09-13,DEV0001 Dev Campaign,Dynamic Ad,1000\r\n',
      })
      expect(await deliveries()).toEqual([])
      expect(provider.sent).toHaveLength(0)
      await server.close()
    })

    it('send-now answers 202 and the email goes out right away', async () => {
      const tracker = createRunTracker()
      const server = buildApp({
        config,
        db: appDb,
        logger: createLogger('silent'),
        emailReports: { db: appDb, mailer, log, now: () => NOW, tracker },
      })
      const res = await server.inject({
        method: 'POST',
        url: `/email-reports/${REPORT}/send-now`,
        headers: auth,
        payload: { period_start: PERIOD.from, period_end: PERIOD.to },
      })
      expect(res.statusCode).toBe(202)
      const { deliveryId } = res.json<{ deliveryId: string }>()
      // The immediate attempt runs in the background.
      expect(await tracker.drain(5_000)).toBe(true)
      const row = at(await deliveries())
      expect(row).toMatchObject({ id: deliveryId, trigger: 'manual', status: 'delivered' })
      expect(provider.sent).toHaveLength(1)
      await server.close()
    })

    it('answers 404 for an unknown report', async () => {
      const server = app()
      const res = await server.inject({
        method: 'POST',
        url: '/email-reports/00000000-0000-4000-8000-0000000009ff/preview',
        headers: auth,
      })
      expect(res.statusCode).toBe(404)
      expect(res.json<{ error: string }>().error).toBe('email_report_not_found')
      await server.close()
    })
  })
})
