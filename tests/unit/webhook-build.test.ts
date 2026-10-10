import { describe, expect, it } from 'vitest'
import {
  buildReport,
  incompleteCampaigns,
  renderReport,
  type ReportTarget,
} from '../../src/modules/webhooks/build.ts'
import { compileFields, payloadFieldsSchema } from '../../src/modules/webhooks/fields.ts'
import type { PayloadFieldsInput } from '../../src/modules/webhooks/fields.ts'
import { at } from '../helpers.ts'
import { fakeDb } from './webhook-fakes.ts'

// What buildReport asks Postgres, and how it reads the answer: bigint and numeric columns arrive as
// text, a NULL column is a metric the source does not measure, and the clicks are read only when a
// formula needs them.

const COMPANY = '00000000-0000-4000-8000-000000000001'
const CAMPAIGN = '00000000-0000-4000-8000-000000000002'
const PERIOD = { from: '2026-10-08', to: '2026-10-08' }

const TARGET: ReportTarget = {
  id: '00000000-0000-4000-8000-0000000009b0',
  companyId: COMPANY,
  campaignIds: [CAMPAIGN],
  timezone: 'Europe/Zurich',
  frequency: 'daily',
  format: 'json',
}

const fields = (input: PayloadFieldsInput) => compileFields(payloadFieldsSchema.parse(input))

const COST = fields({
  columns: [
    { name: 'Impressions', formula: 'impressions', decimals: 0 },
    { name: 'Cost', formula: 'impressions / 1000 * price' },
  ],
})
const CLICKS = fields({ columns: [{ name: 'Clicks', formula: 'clicks', decimals: 0 }] })

const metricsRow = (over: Record<string, unknown> = {}) => ({
  campaign_id: CAMPAIGN,
  campaign: 'DE2610 Tchibo Caffè Crema',
  price: '15.5876',
  events_date: '2026-10-08',
  language: 'de',
  campaign_tag: 'mpu_v1',
  impressions: '12610',
  in_view: null,
  game_started: null,
  game_finished: null,
  interactions: null,
  hovered: null,
  in_view_time: null,
  dwell_time: null,
  interaction_time: null,
  dwell_avg_ms: null,
  unique_impressions_reported: null,
  unique_clicks_reported: null,
  ...over,
})

function database(clicks: unknown[] = []) {
  return fakeDb((text) => {
    if (text.includes('FROM analytics.advanced_analytics')) return [metricsRow()]
    if (text.includes('FROM analytics.cta_clicks')) return clicks
    if (text.includes('FROM app.campaign c')) return [{ name: 'Late Campaign' }]
    return []
  })
}

describe('buildReport', () => {
  it("reads the webhook's campaigns, source and period, and the metrics by name", async () => {
    const db = database()

    const report = await buildReport(db.db, TARGET, PERIOD, COST)

    expect(at(db.matching('FROM analytics.advanced_analytics')).params).toEqual([
      COMPANY,
      [CAMPAIGN],
      'zeus',
      '2026-10-08',
      '2026-10-08',
    ])
    expect(report.names).toEqual(['Date', 'Campaign', 'Impressions', 'Cost'])
    // 12610 × 15.5876 / 1000 = 196.559636, from the text Postgres sent, exactly.
    expect(report.rows).toEqual([['2026-10-08', 'DE2610 Tchibo Caffè Crema', 12610, 196.56]])
  })

  it('reads no clicks when no formula needs them', async () => {
    const db = database()
    await buildReport(db.db, TARGET, PERIOD, COST)
    expect(db.matching('FROM analytics.cta_clicks')).toEqual([])
  })

  it('reads the clicks a formula needs, with the same scope', async () => {
    const db = database([
      {
        campaign_id: CAMPAIGN,
        campaign: 'DE2610 Tchibo Caffè Crema',
        price: null,
        events_date: '2026-10-08',
        clicks: '42',
      },
    ])

    const report = await buildReport(db.db, { ...TARGET, campaignIds: null }, PERIOD, CLICKS)

    expect(at(db.matching('FROM analytics.cta_clicks')).params).toEqual([
      COMPANY,
      null,
      'zeus',
      '2026-10-08',
      '2026-10-08',
    ])
    expect(report.rows).toEqual([['2026-10-08', 'DE2610 Tchibo Caffè Crema', 42]])
  })
})

describe('renderReport', () => {
  it('renders the format of the webhook, with the delivery id inside a JSON body', async () => {
    const report = await buildReport(database().db, TARGET, PERIOD, COST)
    const generatedAt = new Date('2026-10-09T03:00:00Z')

    const json = renderReport(
      TARGET,
      PERIOD,
      report,
      'b0b0b0b0-0000-4000-8000-000000000001',
      generatedAt,
    )
    expect(JSON.parse(json)).toMatchObject({
      delivery_id: 'b0b0b0b0-0000-4000-8000-000000000001',
      period: { start: '2026-10-08', end: '2026-10-08', frequency: 'daily' },
    })

    const csv = renderReport({ ...TARGET, format: 'csv' }, PERIOD, report, null, generatedAt)
    expect(csv).toBe(
      'Date,Campaign,Impressions,Cost\r\n2026-10-08,DE2610 Tchibo Caffè Crema,12610,196.56\r\n',
    )
  })
})

describe('incompleteCampaigns', () => {
  it('asks for the campaigns whose source has not written the period, and names them', async () => {
    const db = database()

    expect(await incompleteCampaigns(db.db, TARGET, 'zeus', PERIOD)).toEqual(['Late Campaign'])
    expect(at(db.matching('external.sync_state')).params).toEqual([
      COMPANY,
      [CAMPAIGN],
      'zeus',
      '2026-10-08',
      '2026-10-08',
    ])
  })
})
