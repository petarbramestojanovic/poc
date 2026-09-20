import { describe, expect, it } from 'vitest'
import { METRIC_IDS } from '../../src/sync/types.ts'
import { metricsSchema, webhookPayloadSchema } from '../../src/webhooks/payload.ts'
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
