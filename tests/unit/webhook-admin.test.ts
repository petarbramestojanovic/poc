import { describe, expect, it } from 'vitest'
import {
  createWebhook,
  FUNNEL_TOKEN_HEADER,
  mintSecret,
  updateWebhook,
  type NewWebhook,
  type WebhookAdminDeps,
} from '../../src/modules/webhooks/admin.ts'
import {
  BlockedTargetError,
  InvalidFormulaError,
  InvalidScheduleError,
  InvalidWebhookError,
  WebhookNotFoundError,
} from '../../src/modules/webhooks/errors.ts'
import { payloadFieldsSchema } from '../../src/modules/webhooks/fields.ts'
import { at } from '../helpers.ts'
import { fakeDb, silentLogger, type Respond } from './webhook-fakes.ts'

// Setting a webhook up and changing it. Everything that would make it undeliverable is refused
// before a statement writes: a cron, a target, a campaign of another company, a formula, and for a
// csv webhook Funnel's token and a public address to link to. The client's key is stored, never
// shown, and can never replace a header we send ourselves.

const NOW = new Date('2026-09-16T10:00:00Z') // a Wednesday
const COMPANY = '00000000-0000-4000-8000-000000000001'
const CAMPAIGN = '00000000-0000-4000-8000-000000000002'
const WEBHOOK = '00000000-0000-4000-8000-0000000009b0'
const BASE = 'https://analytics.example.com'

const FIELDS = payloadFieldsSchema.parse({
  columns: [
    { name: 'Ad Type', value: 'Dynamic Ad' },
    { name: 'Cost', formula: 'impressions / 1000 * price' },
  ],
})

const input = (over: Partial<NewWebhook> = {}): NewWebhook => ({
  companyId: COMPANY,
  name: 'Tchibo daily',
  url: 'https://client.example.com/hook',
  frequency: 'daily',
  fields: FIELDS,
  ...over,
})

const listRow = {
  id: WEBHOOK,
  company_id: COMPANY,
  company_name: 'Tchibo GmbH',
  name: 'Tchibo daily',
  url: 'https://client.example.com/hook',
  campaign_ids: null,
  schedule_cron: '0 5 * * *',
  timezone: 'Europe/Zurich',
  report_window: 'previous_day',
  format: 'json',
  auth_header: 'x-api-key',
  enabled: true,
  next_run_at: new Date('2026-09-17T03:00:00Z'),
  created_at: NOW,
  payload_fields: FIELDS,
  last_delivery: null,
}

/** What lock_webhook.sql finds: a daily json webhook on the default cron, with a stored key. */
const stored = (over: Record<string, unknown> = {}) => ({
  id: WEBHOOK,
  company_id: COMPANY,
  name: 'Tchibo daily',
  campaign_ids: null,
  url: 'https://client.example.com/hook',
  schedule_cron: '0 5 * * *',
  timezone: 'Europe/Zurich',
  report_window: 'previous_day',
  format: 'json',
  auth_header: 'x-api-key',
  auth_token: 'client-key-123',
  enabled: true,
  next_run_at: new Date('2026-09-17T03:00:00Z'),
  payload_fields: FIELDS,
  ...over,
})

/**
 * A database where the company exists and owns CAMPAIGN, which has no price and is linked to Zeus,
 * and where Zeus measures impressions but not dwell.
 */
const knownCompany =
  (current: Record<string, unknown> = stored()): Respond =>
  (text) => {
    if (text.includes('FROM app.company co')) return [{ company_id: COMPANY, owned: [CAMPAIGN] }]
    if (text.includes('INSERT INTO app.webhook')) return [{ id: WEBHOOK }]
    if (text.includes('FOR UPDATE')) return [current]
    if (text.includes('FROM app.webhook w')) return [listRow]
    if (text.includes('FROM external.source s')) {
      return [
        { source_id: 'nexd', metrics: ['impressions', 'dwell_avg_ms'] },
        { source_id: 'zeus', metrics: ['impressions', 'in_view', 'cta_counter'] },
      ]
    }
    if (text.includes('c.price IS NOT NULL')) {
      return [{ name: 'Dev Campaign', has_price: false, linked: true }]
    }
    return []
  }

function setup(respond: Respond = knownCompany(), address = '93.184.216.34') {
  const db = fakeDb(respond)
  const deps: WebhookAdminDeps = {
    db: db.db,
    log: silentLogger(),
    exportBaseUrl: BASE,
    now: () => NOW,
    lookup: () => Promise.resolve([{ address }]),
  }
  return { deps, db }
}

/** insert_webhook.sql's parameters, by name. */
function inserted(db: ReturnType<typeof fakeDb>) {
  const p = at(db.matching('INSERT INTO app.webhook')).params
  return {
    campaignIds: p[2],
    secret: p[4],
    cron: p[5],
    timezone: p[6],
    window: p[7],
    format: p[8],
    authHeader: p[9],
    authToken: p[10],
    version: p[11],
    enabled: p[12],
    nextRunAt: p[13] as Date,
    fields: JSON.parse(p[14] as string) as unknown,
  }
}

/** update_webhook.sql's parameters, by name. */
function updated(db: ReturnType<typeof fakeDb>) {
  const p = at(db.matching('UPDATE app.webhook')).params
  return {
    name: p[1],
    campaignIds: p[2],
    url: p[3],
    cron: p[4],
    timezone: p[5],
    window: p[6],
    format: p[7],
    authHeader: p[8],
    authToken: p[9],
    fields: JSON.parse(p[10] as string) as unknown,
    enabled: p[11],
    nextRunAt: p[12] as Date,
  }
}

describe('mintSecret', () => {
  it('mints 256 bits, differently every time', () => {
    expect(mintSecret()).toMatch(/^whsec_[0-9a-f]{64}$/)
    expect(mintSecret()).not.toBe(mintSecret())
  })
})

describe('createWebhook', () => {
  it('stores a daily json webhook at 05:00 with its columns and a fresh secret, and returns it once', async () => {
    const { deps, db } = setup()

    const result = await createWebhook(deps, input())

    const row = inserted(db)
    expect(row).toMatchObject({
      campaignIds: null,
      cron: '0 5 * * *',
      timezone: 'Europe/Zurich',
      window: 'previous_day',
      format: 'json',
      authHeader: null,
      authToken: null,
      version: 2,
      enabled: true,
      fields: FIELDS,
    })
    // Tomorrow 05:00 in Zurich.
    expect(row.nextRunAt.toISOString()).toBe('2026-09-17T03:00:00.000Z')
    expect(result.secret).toBe(row.secret)
    expect(result.webhook).toMatchObject({ id: WEBHOOK, frequency: 'daily', format: 'json' })
  })

  it('defaults a weekly webhook to Mondays and a monthly one to the 1st', async () => {
    const weekly = setup()
    await createWebhook(weekly.deps, input({ frequency: 'weekly' }))
    expect(inserted(weekly.db)).toMatchObject({ cron: '0 5 * * 1', window: 'previous_week' })
    expect(inserted(weekly.db).nextRunAt.toISOString()).toBe('2026-09-21T03:00:00.000Z')

    const monthly = setup()
    await createWebhook(monthly.deps, input({ frequency: 'monthly' }))
    expect(inserted(monthly.db)).toMatchObject({ cron: '0 5 1 * *', window: 'previous_month' })
  })

  it('keeps a cron of its own, which never changes the period', async () => {
    const { deps, db } = setup()
    await createWebhook(deps, input({ frequency: 'weekly', scheduleCron: '30 7 * * 2' }))
    expect(inserted(db)).toMatchObject({ cron: '30 7 * * 2', window: 'previous_week' })
  })

  it("stores a csv webhook with Funnel's token in Funnel's header", async () => {
    const { deps, db } = setup()

    await createWebhook(deps, input({ format: 'csv', auth: { token: 'fnl_secret' } }))

    expect(inserted(db)).toMatchObject({
      format: 'csv',
      authHeader: FUNNEL_TOKEN_HEADER,
      authToken: 'fnl_secret',
    })
  })

  it('stores a json key under authorization unless another header is named', async () => {
    const plain = setup()
    await createWebhook(plain.deps, input({ auth: { token: 'Bearer abc' } }))
    expect(inserted(plain.db)).toMatchObject({
      authHeader: 'authorization',
      authToken: 'Bearer abc',
    })

    const named = setup()
    await createWebhook(named.deps, input({ auth: { header: 'X-Api-Key', token: 'abc' } }))
    expect(inserted(named.db)).toMatchObject({ authHeader: 'x-api-key' })
  })

  it.each<[string, Partial<NewWebhook>, RegExp]>([
    ['a csv webhook without a token', { format: 'csv' }, /needs the token/],
    [
      'a csv webhook with another header',
      { format: 'csv', auth: { header: 'authorization', token: 'x' } },
      /authenticates with x-funnel-fileimport-token/,
    ],
    [
      'a key in our own signature header',
      { auth: { header: 'x-signature', token: 'x' } },
      /itself/,
    ],
    [
      'a key that would replace the body type',
      { auth: { header: 'content-type', token: 'x' } },
      /itself/,
    ],
  ])('refuses %s before it touches the database', async (_name, over, reason) => {
    const { deps, db } = setup()
    await expect(createWebhook(deps, input(over))).rejects.toThrow(reason)
    expect(db.queries).toEqual([])
  })

  it('refuses a csv webhook while there is no public address to link its file to', async () => {
    const { deps } = setup()
    await expect(
      createWebhook(
        { ...deps, exportBaseUrl: undefined },
        input({ format: 'csv', auth: { token: 'x' } }),
      ),
    ).rejects.toThrow(/PUBLIC_BASE_URL is not set/)
  })

  it('refuses a cron that does not parse', async () => {
    const { deps, db } = setup()
    await expect(createWebhook(deps, input({ scheduleCron: 'tuesdays' }))).rejects.toThrow(
      InvalidScheduleError,
    )
    expect(db.queries).toEqual([])
  })

  it('refuses a target that is not public https', async () => {
    const { deps } = setup(knownCompany(), '10.0.0.5')
    await expect(createWebhook(deps, input())).rejects.toThrow(BlockedTargetError)
  })

  it('refuses a company that does not exist', async () => {
    const { deps } = setup(() => [])
    await expect(createWebhook(deps, input())).rejects.toThrow(/company .* does not exist/)
  })

  it('refuses a campaign that belongs to another company', async () => {
    const { deps, db } = setup()
    const foreign = '00000000-0000-4000-8000-00000000f00d'
    await expect(createWebhook(deps, input({ campaignIds: [CAMPAIGN, foreign] }))).rejects.toThrow(
      InvalidWebhookError,
    )
    expect(db.matching('INSERT INTO app.webhook')).toEqual([])
  })

  it('refuses a formula its source cannot compute, before it stores anything', async () => {
    const { deps, db } = setup()
    const dwell = payloadFieldsSchema.parse({
      columns: [{ name: 'Dwell', formula: 'dwell_avg_ms' }],
    })
    await expect(createWebhook(deps, input({ fields: dwell }))).rejects.toThrow(InvalidFormulaError)
    expect(db.matching('INSERT INTO app.webhook')).toEqual([])
  })

  it('warns about the campaigns whose cost will stay empty', async () => {
    const { deps } = setup()
    const { warnings } = await createWebhook(deps, input())
    expect(warnings).toEqual([
      'these campaigns have no price, so Cost will be empty for them until one is set: Dev Campaign',
    ])
  })

  it('never lists the key, only the header it goes in', async () => {
    const { deps } = setup()
    const { webhook } = await createWebhook(
      deps,
      input({ auth: { header: 'x-api-key', token: 'k' } }),
    )
    expect(webhook.auth).toEqual({ header: 'x-api-key' })
    expect(JSON.stringify(webhook)).not.toContain('client-key')
  })
})

describe('updateWebhook', () => {
  it('changes what it is given and keeps everything else, the key included', async () => {
    const { deps, db } = setup()

    await updateWebhook(deps, WEBHOOK, { name: 'Tchibo daily v2' })

    expect(updated(db)).toMatchObject({
      name: 'Tchibo daily v2',
      cron: '0 5 * * *',
      window: 'previous_day',
      format: 'json',
      authHeader: 'x-api-key',
      authToken: 'client-key-123',
      fields: FIELDS,
      enabled: true,
    })
    // The schedule did not change, so neither does the next run.
    expect(updated(db).nextRunAt.toISOString()).toBe('2026-09-17T03:00:00.000Z')
  })

  it('moves a webhook on its default cron to the new frequency default', async () => {
    const { deps, db } = setup()

    await updateWebhook(deps, WEBHOOK, { frequency: 'weekly' })

    expect(updated(db)).toMatchObject({ cron: '0 5 * * 1', window: 'previous_week' })
    expect(updated(db).nextRunAt.toISOString()).toBe('2026-09-21T03:00:00.000Z')
  })

  it('keeps a cron of its own when only the frequency changes, and resets it with null', async () => {
    const own = setup(knownCompany(stored({ schedule_cron: '15 6 * * *' })))
    await updateWebhook(own.deps, WEBHOOK, { frequency: 'weekly' })
    expect(updated(own.db)).toMatchObject({ cron: '15 6 * * *', window: 'previous_week' })

    const reset = setup(knownCompany(stored({ schedule_cron: '15 6 * * *' })))
    await updateWebhook(reset.deps, WEBHOOK, { scheduleCron: null })
    expect(updated(reset.db).cron).toBe('0 5 * * *')
  })

  it('replaces the key, or removes it with null', async () => {
    const replaced = setup()
    await updateWebhook(replaced.deps, WEBHOOK, { auth: { token: 'new-key' } })
    expect(updated(replaced.db)).toMatchObject({
      authHeader: 'authorization',
      authToken: 'new-key',
    })

    const removed = setup()
    await updateWebhook(removed.deps, WEBHOOK, { auth: null })
    expect(updated(removed.db)).toMatchObject({ authHeader: null, authToken: null })
  })

  it("turns a webhook into csv only with Funnel's token", async () => {
    const without = setup()
    await expect(updateWebhook(without.deps, WEBHOOK, { format: 'csv' })).rejects.toThrow(
      /authenticates with x-funnel-fileimport-token/,
    )
    expect(without.db.matching('UPDATE app.webhook')).toEqual([])

    const withToken = setup()
    await updateWebhook(withToken.deps, WEBHOOK, { format: 'csv', auth: { token: 'fnl' } })
    expect(updated(withToken.db)).toMatchObject({
      format: 'csv',
      authHeader: FUNNEL_TOKEN_HEADER,
      authToken: 'fnl',
    })
  })

  it("never removes a csv webhook's token", async () => {
    const csv = stored({ format: 'csv', auth_header: FUNNEL_TOKEN_HEADER, auth_token: 'fnl' })
    const { deps } = setup(knownCompany(csv))
    await expect(updateWebhook(deps, WEBHOOK, { auth: null })).rejects.toThrow(/needs the token/)
  })

  it('lets a csv webhook be edited and disabled while PUBLIC_BASE_URL is unset', async () => {
    const csv = stored({ format: 'csv', auth_header: FUNNEL_TOKEN_HEADER, auth_token: 'fnl' })
    const { deps, db } = setup(knownCompany(csv))
    await updateWebhook({ ...deps, exportBaseUrl: undefined }, WEBHOOK, { enabled: false })
    expect(updated(db).enabled).toBe(false)
  })

  it('schedules a re-enabled webhook from now, not from a run long gone', async () => {
    const off = stored({ enabled: false, next_run_at: new Date('2026-08-01T03:00:00Z') })
    const { deps, db } = setup(knownCompany(off))
    await updateWebhook(deps, WEBHOOK, { enabled: true })
    expect(updated(db).nextRunAt.toISOString()).toBe('2026-09-17T03:00:00.000Z')
  })

  it('checks new campaigns, a new target and new columns like creation does', async () => {
    const foreign = '00000000-0000-4000-8000-00000000f00d'
    const campaigns = setup()
    await expect(
      updateWebhook(campaigns.deps, WEBHOOK, { campaignIds: [foreign] }),
    ).rejects.toThrow(/not campaigns of company/)

    const target = setup(knownCompany(), '127.0.0.1')
    await expect(
      updateWebhook(target.deps, WEBHOOK, { url: 'https://internal.example.com/hook' }),
    ).rejects.toThrow(BlockedTargetError)

    const columns = setup()
    await expect(
      updateWebhook(columns.deps, WEBHOOK, {
        fields: payloadFieldsSchema.parse({
          columns: [{ name: 'Dwell', formula: 'dwell_avg_ms' }],
        }),
      }),
    ).rejects.toThrow(InvalidFormulaError)
  })

  it('asks for columns before changing a webhook set up before version 2', async () => {
    const legacy = stored({ payload_fields: { calculated: [] } })
    const missing = setup(knownCompany(legacy))
    await expect(updateWebhook(missing.deps, WEBHOOK, { enabled: false })).rejects.toThrow(
      /pass fields with this change/,
    )

    const given = setup(knownCompany(legacy))
    await updateWebhook(given.deps, WEBHOOK, { fields: FIELDS })
    expect(updated(given.db).fields).toEqual(FIELDS)
  })

  it('answers not found for a webhook that does not exist', async () => {
    const { deps } = setup(() => [])
    await expect(updateWebhook(deps, WEBHOOK, { name: 'x' })).rejects.toThrow(WebhookNotFoundError)
  })
})
