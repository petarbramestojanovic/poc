import { describe, expect, it } from 'vitest'
import { compileFields, payloadFieldsSchema } from '../../src/modules/webhooks/fields.ts'
import type { PayloadFieldsInput } from '../../src/modules/webhooks/fields.ts'
import {
  assembleRows,
  type ClicksRecord,
  type MetricsRecord,
} from '../../src/modules/webhooks/rows.ts'

// One row per campaign and day. The fixture can break every rule of the rows:
//   * the campaign runs in German and French: two language rows of 1001 impressions each make one
//     report row of 2002, whose cost (31.21) is not the sum of the rounded per-language costs (31.20),
//   * a day without a stored row must be skipped, not reported as zeros,
//   * a campaign without a price must get an empty cost, never 0.

const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b2'

const fields = (input: PayloadFieldsInput) => compileFields(payloadFieldsSchema.parse(input))

const TCHIBO = fields({
  columns: [
    { name: 'Ad Type', value: 'Dynamic Ad' },
    { name: 'Impressions', formula: 'impressions', decimals: 0 },
    { name: 'Clicks', formula: 'clicks', decimals: 0 },
    { name: 'Cost', formula: 'impressions / 1000 * price' },
  ],
})

const metrics = (over: Partial<MetricsRecord> = {}): MetricsRecord => ({
  campaignId: A,
  campaign: 'DE2610 Tchibo Caffè Crema',
  price: '15.5876',
  date: '2026-10-08',
  language: 'de',
  campaignTag: 'mpu_v1',
  metrics: { impressions: 1001, in_view: 800 },
  ...over,
})

const clicks = (over: Partial<ClicksRecord> = {}): ClicksRecord => ({
  campaignId: A,
  campaign: 'DE2610 Tchibo Caffè Crema',
  price: '15.5876',
  date: '2026-10-08',
  clicks: '7',
  ...over,
})

describe('assembleRows', () => {
  it('starts every row with the date and the campaign name, then the columns in order', () => {
    expect(assembleRows(TCHIBO, [metrics()], [clicks()])).toEqual([
      ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 1001, 7, 15.6],
    ])
  })

  it("merges a day's languages and creatives into one row and costs the merged numbers", () => {
    const rows = assembleRows(
      TCHIBO,
      [metrics(), metrics({ language: 'fr', campaignTag: 'mpu_v2' })],
      [clicks({ clicks: '12' })],
    )
    // 2002 / 1000 × 15.5876 = 31.2063…, rounded once. Per language it would be 15.60 + 15.60.
    expect(rows).toEqual([
      ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 2002, 12, 31.21],
    ])
  })

  it('skips a day without a single stored row instead of reporting zeros', () => {
    const rows = assembleRows(
      TCHIBO,
      [metrics({ date: '2026-10-06' }), metrics({ date: '2026-10-08' })],
      [clicks({ date: '2026-10-06' }), clicks({ date: '2026-10-08' })],
    )
    expect(rows.map((row) => row[0])).toEqual(['2026-10-06', '2026-10-08'])
  })

  it('gives a campaign without a price an empty cost, never 0', () => {
    const [row] = assembleRows(TCHIBO, [metrics({ price: null })], [clicks({ price: null })])
    expect(row).toEqual(['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 1001, 7, null])
  })

  it('gives a day without click rows empty clicks, and a day with only clicks a row', () => {
    const rows = assembleRows(
      TCHIBO,
      [metrics({ date: '2026-10-07' })],
      [clicks({ date: '2026-10-08', clicks: '3' })],
    )
    expect(rows).toEqual([
      ['2026-10-07', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 1001, null, 15.6],
      ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', null, 3, null],
    ])
  })

  it('leaves a metric the source does not measure empty', () => {
    const viewable = fields({ columns: [{ name: 'Viewable', formula: 'in_view / impressions' }] })
    const [row] = assembleRows(viewable, [metrics({ metrics: { impressions: 1000 } })], [])
    expect(row).toEqual(['2026-10-08', 'DE2610 Tchibo Caffè Crema', null])
  })

  it('weighs averages and never adds the per-day unique scalars across languages', () => {
    const warnings: string[] = []
    const dwell = fields({
      columns: [
        { name: 'Dwell', formula: 'dwell_avg_ms' },
        { name: 'Unique clicks', formula: 'unique_clicks_reported', decimals: 0 },
      ],
    })
    const [row] = assembleRows(
      dwell,
      [
        metrics({ metrics: { game_started: 100, dwell_avg_ms: 1000, unique_clicks_reported: 5 } }),
        metrics({
          language: 'fr',
          metrics: { game_started: 300, dwell_avg_ms: 2000, unique_clicks_reported: 9 },
        }),
      ],
      [],
      (message) => warnings.push(message),
    )
    // (100 × 1000 + 300 × 2000) / 400, not the plain mean 1500; 5 and 9 are never added.
    expect(row).toEqual(['2026-10-08', 'DE2610 Tchibo Caffè Crema', 1750, null])
    expect(warnings).toEqual([
      expect.stringMatching(/^DE2610 Tchibo Caffè Crema: unique_clicks_reported dropped/),
    ])
  })

  it('orders day by day, and within a day by campaign name', () => {
    const rows = assembleRows(
      TCHIBO,
      [
        metrics({ date: '2026-10-08' }),
        metrics({ campaignId: B, campaign: 'AT2610 Tchibo Barista', date: '2026-10-08' }),
        metrics({ date: '2026-10-07' }),
      ],
      [],
    )
    expect(rows.map((row) => [row[0], row[1]])).toEqual([
      ['2026-10-07', 'DE2610 Tchibo Caffè Crema'],
      ['2026-10-08', 'AT2610 Tchibo Barista'],
      ['2026-10-08', 'DE2610 Tchibo Caffè Crema'],
    ])
  })

  it('keeps two campaigns of the same name apart', () => {
    const rows = assembleRows(TCHIBO, [metrics(), metrics({ campaignId: B })], [])
    expect(rows).toHaveLength(2)
  })

  it('has no rows when nothing was stored', () => {
    expect(assembleRows(TCHIBO, [], [])).toEqual([])
  })
})
