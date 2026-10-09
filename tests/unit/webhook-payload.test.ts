import { describe, expect, it } from 'vitest'
import { METRIC_IDS } from '../../src/modules/sync/types.ts'
import {
  metricsSchema,
  PAYLOAD_SECTIONS,
  webhookPayloadSchema,
  webhookPayloadSchemaFor,
} from '../../src/modules/webhooks/payload.ts'
import { at } from '../helpers.ts'

// The contract the database answers to. Every case below is one valid v1 body with one thing
// changed, so a failure names exactly which part of the contract broke.

type Overrides = Record<string, unknown>

const sourceBlock = (overrides: Overrides = {}): Overrides => ({
  source: 'zeus',
  display_name: 'ATK (Zeus)',
  role: 'primary',
  day_timezone: 'UTC',
  data_complete_through: '2026-09-13',
  last_synced_at: '2026-09-14T02:10:00Z',
  metrics_available: ['impressions', 'unique_clicks_reported'],
  totals: { impressions: 900, unique_clicks_reported: null },
  daily: [{ date: '2026-09-07', language: 'de', impressions: 900, unique_clicks_reported: 12 }],
  creatives: [],
  ctas: [],
  pages: [],
  ...overrides,
})

const payload = (block: Overrides = {}, overrides: Overrides = {}): Overrides => ({
  version: 1,
  delivery_id: null,
  generated_at: '2026-09-20T04:05:00Z',
  period: {
    start: '2026-09-07',
    end: '2026-09-13',
    timezone: 'Europe/Zurich',
    window: 'previous_week',
  },
  company: { id: '00000000-0000-4000-8000-000000000001', name: 'Dev Company' },
  campaigns: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'DEV0001 Dev Campaign',
      primary_source: 'zeus',
      sources: [sourceBlock(block)],
    },
  ],
  ...overrides,
})

const reasons = (body: Overrides): string => {
  const result = webhookPayloadSchema.safeParse(body)
  expect(result.success).toBe(false)
  return (result.error?.issues ?? []).map((issue) => issue.message).join(' | ')
}

describe('webhook payload contract v1', () => {
  it('describes exactly the metrics of the catalog', () => {
    expect(Object.keys(metricsSchema.shape)).toEqual([...METRIC_IDS])
  })

  it('accepts a well-formed body', () => {
    const parsed = webhookPayloadSchema.parse(payload())
    const block = at(at(parsed.campaigns).sources)

    expect(block.totals.impressions).toBe(900)
    expect(at(block.daily).unique_clicks_reported).toBe(12)
  })

  it('treats an absent metric and a null metric as different', () => {
    // Absent = the source does not measure it; null = measured, no value for this range.
    expect(metricsSchema.parse({ impressions: 5 })).toEqual({ impressions: 5 })
    expect(metricsSchema.parse({ impressions: 5, hovered: null })).toEqual({
      impressions: 5,
      hovered: null,
    })
  })

  it('rejects a metric the catalog does not define', () => {
    expect(metricsSchema.safeParse({ impressions: 5, clicks: 3 }).success).toBe(false)
  })

  it('rejects a summed unique_* total', () => {
    const totals = { impressions: 900, unique_clicks_reported: 84 }
    expect(reasons(payload({ totals }))).toMatch(/per-day scalar/)
  })

  it('rejects a fractional count', () => {
    const totals = { impressions: 900.5, unique_clicks_reported: null }
    expect(reasons(payload({ totals }))).toMatch(/int/i)
  })

  it('rejects an unknown role', () => {
    expect(reasons(payload({ role: 'headline' }))).not.toBe('')
  })

  it('rejects a payload of another version', () => {
    expect(reasons(payload({}, { version: 2 }))).not.toBe('')
  })

  it('rejects a field the contract does not describe', () => {
    expect(reasons(payload({ clicks: 12 }))).not.toBe('')
  })
})

describe('webhookPayloadSchemaFor', () => {
  const full = webhookPayloadSchemaFor({ sections: PAYLOAD_SECTIONS, calculated: [], price: false })
  const costed = webhookPayloadSchemaFor({ sections: ['daily'], calculated: ['cost'], price: true })

  /** The body a Tchibo-style field list produces: cost everywhere, a price, no ctas or pages. */
  const costedBody = (block: Overrides = {}, campaign: Overrides = {}): Overrides => {
    const body = payload({
      metrics_available: ['impressions', 'cost'],
      totals: { impressions: 900, cost: 14.03 },
      daily: [{ date: '2026-09-07', language: 'de', impressions: 900, cost: 14.03 }],
      creatives: [{ campaign_tag: 'mpu', label: null, totals: { impressions: 900, cost: 14.03 } }],
      ctas: undefined,
      pages: undefined,
      ...block,
    })
    const [first] = body.campaigns as Overrides[]
    return { ...body, campaigns: [{ ...first, price: 15.5876, currency: 'EUR', ...campaign }] }
  }
  const strip = (body: Overrides): unknown => JSON.parse(JSON.stringify(body))

  it('describes the same body as the full schema when nothing is narrowed', () => {
    expect(full.safeParse(payload()).success).toBe(true)
    expect(
      full.safeParse(payload({ totals: { impressions: 900, unique_clicks_reported: 84 } })).success,
    ).toBe(false)
    expect(full.safeParse(payload({ clicks: 12 })).success).toBe(false)
  })

  it('accepts the body a field list produces', () => {
    expect(costed.parse(strip(costedBody()))).toBeDefined()
  })

  it('refuses a list the field list leaves out', () => {
    expect(costed.safeParse(strip(costedBody({ ctas: [] }))).success).toBe(false)
  })

  it('refuses a calculated key the field list does not define', () => {
    const totals = { impressions: 900, cost: 14.03, ctr: 0.01 }
    expect(costed.safeParse(strip(costedBody({ totals }))).success).toBe(false)
  })

  it('still refuses a summed per-day unique, in totals and in a creative', () => {
    const totals = { impressions: 900, cost: 14.03, unique_clicks_reported: 84 }
    expect(costed.safeParse(strip(costedBody({ totals }))).success).toBe(false)
    const creatives = [{ campaign_tag: 'mpu', label: null, totals }]
    expect(costed.safeParse(strip(costedBody({ creatives }))).success).toBe(false)
  })

  it('requires the price beside a formula that uses it, and nothing else on the campaign', () => {
    const withoutPrice = strip(costedBody()) as { campaigns: Record<string, unknown>[] }
    delete withoutPrice.campaigns[0]?.price
    expect(costed.safeParse(withoutPrice).success).toBe(false)
    expect(full.safeParse(strip(payload())).success).toBe(true)
    expect(costed.safeParse(strip(costedBody({}, { budget: 1 }))).success).toBe(false)
  })
})
