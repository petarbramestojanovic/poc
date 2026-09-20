import { describe, expect, it } from 'vitest'
import {
  createWebhook,
  mintSecret,
  scheduleWarnings,
  type NewWebhook,
  type WebhookAdminDeps,
} from '../../src/webhooks/admin.ts'
import {
  BlockedTargetError,
  InvalidScheduleError,
  InvalidWebhookError,
} from '../../src/webhooks/errors.ts'
import { at } from '../helpers.ts'
import { fakeDb, silentLogger, type Respond } from './webhook-fakes.ts'

const NOW = new Date('2026-09-16T10:00:00Z') // a Wednesday
const COMPANY = '00000000-0000-4000-8000-000000000001'
const CAMPAIGN = '00000000-0000-4000-8000-000000000002'
const WEBHOOK = '00000000-0000-4000-8000-0000000009b0'

const input = (over: Partial<NewWebhook> = {}): NewWebhook => ({
  companyId: COMPANY,
  name: 'weekly report',
  url: 'https://client.example.com/hook',
  scheduleCron: '0 8 * * 1',
  ...over,
})

const listRow = {
  id: WEBHOOK,
  company_id: COMPANY,
  company_name: 'Dev Company',
  name: 'weekly report',
  url: 'https://client.example.com/hook',
  campaign_ids: null,
  schedule_cron: '0 8 * * 1',
  timezone: 'Europe/Zurich',
  report_window: 'previous_week',
  include_check_sources: true,
  include_creatives: true,
  enabled: true,
  next_run_at: new Date('2026-09-21T06:00:00Z'),
  created_at: NOW,
  last_delivery: null,
}

/** A database where the company exists and owns CAMPAIGN. */
const knownCompany: Respond = (text) => {
  if (text.includes('FROM app.company co')) return [{ company_id: COMPANY, owned: [CAMPAIGN] }]
  if (text.includes('INSERT INTO app.webhook')) return [{ id: WEBHOOK }]
  if (text.includes('FROM app.webhook w')) return [listRow]
  return []
}

function setup(respond: Respond = knownCompany, address = '93.184.216.34') {
  const db = fakeDb(respond)
  const deps: WebhookAdminDeps = {
    db: db.db,
    log: silentLogger(),
    now: () => NOW,
    lookup: () => Promise.resolve([{ address }]),
  }
  return { deps, db }
}

describe('mintSecret', () => {
  it('mints 256 bits, differently every time', () => {
    expect(mintSecret()).toMatch(/^whsec_[0-9a-f]{64}$/)
    expect(mintSecret()).not.toBe(mintSecret())
  })
})

describe('scheduleWarnings', () => {
  it('says nothing about a morning report', () => {
    expect(scheduleWarnings(new Date('2026-09-21T06:00:00Z'), 'Europe/Zurich')).toEqual([])
  })

  it('warns about a report that fires before the nightly sync has settled', () => {
    // 03:00 in Zurich: the 04:00 pass has not restated yesterday yet.
    const warnings = scheduleWarnings(new Date('2026-09-21T01:00:00Z'), 'Europe/Zurich')
    expect(at(warnings)).toMatch(/03:xx Europe\/Zurich/)
  })

  it('judges the hour in the webhook timezone, not in UTC', () => {
    // 02:00 UTC is 11:00 in Tokyo: fine there.
    expect(scheduleWarnings(new Date('2026-09-21T02:00:00Z'), 'Asia/Tokyo')).toEqual([])
  })
})

describe('createWebhook', () => {
  it('stores the schedule, the first run and a fresh secret, and hands the secret back once', async () => {
    const { deps, db } = setup()

    const created = await createWebhook(deps, input())

    const params = at(db.matching('INSERT INTO app.webhook')).params
    expect(params[4]).toBe(created.secret)
    expect(created.secret).toMatch(/^whsec_/)
    // Wednesday 10:00 UTC → the coming Monday, 08:00 in Zurich.
    expect((params[11] as Date).toISOString()).toBe('2026-09-21T06:00:00.000Z')
    expect(params[6]).toBe('Europe/Zurich')
    expect(params[7]).toBe('previous_week')
    // What comes back to be listed never carries it.
    expect(JSON.stringify(created.webhook)).not.toContain(created.secret)
    expect(created.warnings).toEqual([])
  })

  it('refuses a cron that does not parse, before it touches the database', async () => {
    const { deps, db } = setup()
    await expect(
      createWebhook(deps, input({ scheduleCron: 'mondays at 8' })),
    ).rejects.toBeInstanceOf(InvalidScheduleError)
    expect(db.queries).toEqual([])
  })

  it('refuses a target that is not public https', async () => {
    const http = setup()
    await expect(
      createWebhook(http.deps, input({ url: 'http://client.example.com/hook' })),
    ).rejects.toBeInstanceOf(BlockedTargetError)

    const internal = setup(knownCompany, '10.0.0.5')
    await expect(createWebhook(internal.deps, input())).rejects.toBeInstanceOf(BlockedTargetError)
    expect(internal.db.matching('INSERT INTO app.webhook')).toEqual([])
  })

  it('refuses a company that does not exist', async () => {
    const { deps } = setup(() => [])
    await expect(createWebhook(deps, input())).rejects.toThrow(/does not exist/)
  })

  it('refuses a campaign that belongs to another company', async () => {
    const foreign = '00000000-0000-4000-8000-00000000f00d'
    const { deps, db } = setup()

    await expect(
      createWebhook(deps, input({ campaignIds: [CAMPAIGN, foreign] })),
    ).rejects.toBeInstanceOf(InvalidWebhookError)
    expect(db.matching('INSERT INTO app.webhook')).toEqual([])
  })

  it('passes the warning about an early schedule through', async () => {
    const { deps } = setup()
    const created = await createWebhook(deps, input({ scheduleCron: '30 3 * * *' }))
    expect(at(created.warnings)).toMatch(/nightly sync/)
  })
})
