import { describe, expect, it } from 'vitest'
import { compileFields, payloadFieldsSchema } from '../../src/modules/webhooks/fields.ts'
import type { PayloadFieldsInput } from '../../src/modules/webhooks/fields.ts'
import {
  assembleRows,
  labelKey,
  type ClicksRecord,
  type MetricsRecord,
  type SourceData,
} from '../../src/modules/webhooks/rows.ts'

// One row per campaign and day — or per creative and day. The fixture can break every rule of
// the rows:
//   * the campaign runs in German and French: two language rows of 1001 impressions each make one
//     report row of 2002, whose cost (31.21) is not the sum of the rounded per-language costs (31.20),
//   * a day without a stored row must be skipped, not reported as zeros,
//   * a campaign without a price must get an empty cost, never 0,
//   * two row sets are two series: a Zeus campaign row and NEXD creative rows under it, nothing
//     added across them, each column filled only by the row set that binds it.

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

const TCHIBO_ROWS: PayloadFieldsInput = {
  columns: ['Creative Format', 'Ad Type', 'Impressions', 'Clicks', 'Cost'],
  rows: [
    {
      source: 'zeus',
      values: {
        'Ad Type': { value: 'Dynamic Ad' },
        Impressions: { formula: 'impressions', decimals: 0 },
        Clicks: { formula: 'clicks', decimals: 0 },
        Cost: { formula: 'impressions / 1000 * price' },
      },
    },
    {
      source: 'nexd',
      level: 'creative',
      values: {
        'Creative Format': { value: 'Display' },
        'Ad Type': { value: 'Dynamic Ad' },
        Impressions: { formula: 'impressions', decimals: 0 },
        Cost: { formula: 'impressions / 1000 * price' },
      },
    },
  ],
}

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
  campaignTag: 'mpu_v1',
  clicks: '7',
  ...over,
})

const zeus = (
  rows: MetricsRecord[],
  clickRows: ClicksRecord[] = [],
  labels: [string, string][] = [],
): SourceData => ({ source: 'zeus', metrics: rows, clicks: clickRows, labels: new Map(labels) })

const nexd = (rows: MetricsRecord[], labels: [string, string][] = []): SourceData => ({
  source: 'nexd',
  metrics: rows,
  clicks: [],
  labels: new Map(labels),
})

describe('assembleRows', () => {
  it('starts every row with the date and the campaign name, then the columns in order', () => {
    expect(assembleRows(TCHIBO, [zeus([metrics()], [clicks()])])).toEqual([
      ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 1001, 7, 15.6],
    ])
  })

  it("merges a day's languages and creatives into one row and costs the merged numbers", () => {
    const rows = assembleRows(TCHIBO, [
      zeus(
        [metrics(), metrics({ language: 'fr', campaignTag: 'mpu_v2' })],
        [clicks({ clicks: '12' }), clicks({ campaignTag: 'mpu_v2', clicks: '3' })],
      ),
    ])
    // 2002 / 1000 × 15.5876 = 31.2063…, rounded once. Per language it would be 15.60 + 15.60.
    // Clicks are a sum, so the two creatives' 12 and 3 make 15.
    expect(rows).toEqual([
      ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 2002, 15, 31.21],
    ])
  })

  it('skips a day without a single stored row instead of reporting zeros', () => {
    const rows = assembleRows(TCHIBO, [
      zeus(
        [metrics({ date: '2026-10-06' }), metrics({ date: '2026-10-08' })],
        [clicks({ date: '2026-10-06' }), clicks({ date: '2026-10-08' })],
      ),
    ])
    expect(rows.map((row) => row[0])).toEqual(['2026-10-06', '2026-10-08'])
  })

  it('gives a campaign without a price an empty cost, never 0', () => {
    const [row] = assembleRows(TCHIBO, [
      zeus([metrics({ price: null })], [clicks({ price: null })]),
    ])
    expect(row).toEqual(['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 1001, 7, null])
  })

  it('gives a day without click rows empty clicks, and a day with only clicks a row', () => {
    const rows = assembleRows(TCHIBO, [
      zeus([metrics({ date: '2026-10-07' })], [clicks({ date: '2026-10-08', clicks: '3' })]),
    ])
    expect(rows).toEqual([
      ['2026-10-07', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 1001, null, 15.6],
      ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', null, 3, null],
    ])
  })

  it('leaves a metric the source does not measure empty', () => {
    const viewable = fields({ columns: [{ name: 'Viewable', formula: 'in_view / impressions' }] })
    const [row] = assembleRows(viewable, [zeus([metrics({ metrics: { impressions: 1000 } })])])
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
        zeus([
          metrics({
            metrics: { game_started: 100, dwell_avg_ms: 1000, unique_clicks_reported: 5 },
          }),
          metrics({
            language: 'fr',
            metrics: { game_started: 300, dwell_avg_ms: 2000, unique_clicks_reported: 9 },
          }),
        ]),
      ],
      (message) => warnings.push(message),
    )
    // (100 × 1000 + 300 × 2000) / 400, not the plain mean 1500; 5 and 9 are never added.
    expect(row).toEqual(['2026-10-08', 'DE2610 Tchibo Caffè Crema', 1750, null])
    expect(warnings).toEqual([
      expect.stringMatching(/^DE2610 Tchibo Caffè Crema: unique_clicks_reported dropped/),
    ])
  })

  it('orders day by day, and within a day by campaign name', () => {
    const rows = assembleRows(TCHIBO, [
      zeus([
        metrics({ date: '2026-10-08' }),
        metrics({ campaignId: B, campaign: 'AT2610 Tchibo Barista', date: '2026-10-08' }),
        metrics({ date: '2026-10-07' }),
      ]),
    ])
    expect(rows.map((row) => [row[0], row[1]])).toEqual([
      ['2026-10-07', 'DE2610 Tchibo Caffè Crema'],
      ['2026-10-08', 'AT2610 Tchibo Barista'],
      ['2026-10-08', 'DE2610 Tchibo Caffè Crema'],
    ])
  })

  it('keeps two campaigns of the same name apart', () => {
    const rows = assembleRows(TCHIBO, [zeus([metrics(), metrics({ campaignId: B })])])
    expect(rows).toHaveLength(2)
  })

  it('has no rows when nothing was stored', () => {
    expect(assembleRows(TCHIBO, [])).toEqual([])
    expect(assembleRows(TCHIBO, [zeus([])])).toEqual([])
  })

  describe('row sets', () => {
    const ROWS = fields(TCHIBO_ROWS)
    const kw43 = metrics({ campaignTag: 'nx_kw43', metrics: { impressions: 114043 } })
    const kw42 = metrics({ campaignTag: 'nx_kw42', metrics: { impressions: 148210 } })
    const kw42fr = metrics({
      campaignTag: 'nx_kw42',
      language: 'fr',
      metrics: { impressions: 1000 },
    })
    const names: [string, string][] = [
      [labelKey(A, 'nx_kw43'), 'KW43 Kids'],
      [labelKey(A, 'nx_kw42'), 'KW42 Run Club'],
    ]

    it('puts the campaign row first, then one row per creative with its label, each from its own source', () => {
      const rows = assembleRows(ROWS, [
        zeus([metrics({ metrics: { impressions: 1074817 } })], [clicks({ clicks: '39062' })]),
        nexd([kw43, kw42, kw42fr], names),
      ])
      // Date, Campaign, Creative, Creative Format, Ad Type, Impressions, Clicks, Cost.
      expect(rows).toEqual([
        [
          '2026-10-08',
          'DE2610 Tchibo Caffè Crema',
          null,
          null,
          'Dynamic Ad',
          1074817,
          39062,
          16753.82,
        ],
        // KW42's German and French rows merged; its cost from the merged 149210, once.
        [
          '2026-10-08',
          'DE2610 Tchibo Caffè Crema',
          'KW42 Run Club',
          'Display',
          'Dynamic Ad',
          149210,
          null,
          2325.83,
        ],
        [
          '2026-10-08',
          'DE2610 Tchibo Caffè Crema',
          'KW43 Kids',
          'Display',
          'Dynamic Ad',
          114043,
          null,
          1777.66,
        ],
      ])
    })

    it('reads a source only through the row sets that name it: NEXD impressions never reach the Zeus row', () => {
      const rows = assembleRows(ROWS, [nexd([kw43], names)])
      expect(rows).toEqual([
        [
          '2026-10-08',
          'DE2610 Tchibo Caffè Crema',
          'KW43 Kids',
          'Display',
          'Dynamic Ad',
          114043,
          null,
          1777.66,
        ],
      ])
    })

    it('prints the tag for a creative nobody labelled', () => {
      const rows = assembleRows(ROWS, [nexd([kw43])])
      expect(rows.map((row) => row[2])).toEqual(['nx_kw43'])
    })

    it('names a row after its creative when the row set says so, and then needs no Creative column', () => {
      const named = fields({
        ...TCHIBO_ROWS,
        rows: TCHIBO_ROWS.rows.map((set, i) => (i === 1 ? { ...set, name: 'creative' } : set)),
      })
      const rows = assembleRows(named, [
        zeus([metrics({ metrics: { impressions: 1074817 } })], [clicks({ clicks: '39062' })]),
        nexd([kw43], names),
      ])
      expect(named.names).toEqual([
        'Date',
        'Campaign',
        'Creative Format',
        'Ad Type',
        'Impressions',
        'Clicks',
        'Cost',
      ])
      expect(rows).toEqual([
        ['2026-10-08', 'DE2610 Tchibo Caffè Crema', null, 'Dynamic Ad', 1074817, 39062, 16753.82],
        ['2026-10-08', 'KW43 Kids', 'Display', 'Dynamic Ad', 114043, null, 1777.66],
      ])
    })

    it('keeps the campaign name on a creative-named row whose creative has no tag at all', () => {
      const named = fields({
        columns: ['Impressions'],
        rows: [
          {
            source: 'zeus',
            level: 'creative',
            name: 'creative',
            values: { Impressions: { formula: 'impressions' } },
          },
        ],
      })
      // A Zeus link with only a campaign entity stamps rows with the empty tag.
      const rows = assembleRows(named, [zeus([metrics({ campaignTag: '' })])])
      expect(rows).toEqual([['2026-10-08', 'DE2610 Tchibo Caffè Crema', 1001]])
    })

    it('prints the source and the level where a client asked for them', () => {
      const kinds = fields({
        columns: ['Source', 'Level', 'Impressions'],
        rows: [
          {
            source: 'zeus',
            values: {
              Source: { variable: 'source' },
              Level: { variable: 'level' },
              Impressions: { formula: 'impressions' },
            },
          },
          {
            source: 'nexd',
            level: 'creative',
            values: {
              Source: { variable: 'source' },
              Level: { variable: 'level' },
              Impressions: { formula: 'impressions' },
            },
          },
        ],
      })
      const rows = assembleRows(kinds, [zeus([metrics()]), nexd([kw43], names)])
      expect(rows.map((row) => row.slice(2, 5))).toEqual([
        [null, 'zeus', 'campaign'],
        ['KW43 Kids', 'nexd', 'creative'],
      ])
    })

    it('splits clicks by creative at creative level, and adds them up at campaign level', () => {
      const ctr = fields({
        columns: ['Clicks'],
        rows: [
          { source: 'zeus', values: { Clicks: { formula: 'clicks' } } },
          { source: 'zeus', level: 'creative', values: { Clicks: { formula: 'clicks' } } },
        ],
      })
      const rows = assembleRows(ctr, [
        zeus(
          [metrics(), metrics({ campaignTag: 'mpu_v2' })],
          [clicks({ clicks: '7' }), clicks({ campaignTag: 'mpu_v2', clicks: '5' })],
          [
            [labelKey(A, 'mpu_v1'), 'MPU V1'],
            [labelKey(A, 'mpu_v2'), 'MPU V2'],
          ],
        ),
      ])
      expect(rows).toEqual([
        ['2026-10-08', 'DE2610 Tchibo Caffè Crema', null, 12],
        ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'MPU V1', 7],
        ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'MPU V2', 5],
      ])
    })

    it('orders within a campaign by row set, then creatives by name', () => {
      const rows = assembleRows(ROWS, [
        zeus([metrics({ date: '2026-10-09' }), metrics({ date: '2026-10-08' })]),
        nexd(
          [
            kw42,
            kw43,
            metrics({ date: '2026-10-09', campaignTag: 'nx_kw43' }),
            metrics({ campaignId: B, campaign: 'AT2610 Tchibo Barista', campaignTag: 'nx_at' }),
          ],
          names,
        ),
      ])
      expect(rows.map((row) => [row[0], row[1], row[2]])).toEqual([
        ['2026-10-08', 'AT2610 Tchibo Barista', 'nx_at'],
        ['2026-10-08', 'DE2610 Tchibo Caffè Crema', null],
        ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'KW42 Run Club'],
        ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'KW43 Kids'],
        ['2026-10-09', 'DE2610 Tchibo Caffè Crema', null],
        ['2026-10-09', 'DE2610 Tchibo Caffè Crema', 'KW43 Kids'],
      ])
    })
  })
})
