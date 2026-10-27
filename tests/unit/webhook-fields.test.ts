import { describe, expect, it } from 'vitest'
import { InvalidFormulaError, InvalidWebhookError } from '../../src/modules/webhooks/errors.ts'
import {
  compileFields,
  fieldWarnings,
  metricsRead,
  payloadFieldsSchema,
  readStoredFields,
  validateFields,
  type CompiledFields,
  type PayloadFieldsInput,
  type ScopeCampaign,
} from '../../src/modules/webhooks/fields.ts'
import { at } from '../helpers.ts'
import { fakeDb } from './webhook-fakes.ts'

// A webhook's column list: what it refuses, and what it compiles to. Tchibo's Funnel sheet is the
// fixture, in both forms: the one-source list (Date, Campaign, then a fixed "Ad Type", impressions,
// clicks and a cost, all from Zeus), and the row sets that add one NEXD row per creative under it.

const TCHIBO: PayloadFieldsInput = {
  columns: [
    { name: 'Ad Type', value: 'Dynamic Ad' },
    { name: 'Impressions', formula: 'impressions', decimals: 0 },
    { name: 'Clicks', formula: 'clicks', decimals: 0 },
    { name: 'Cost', formula: 'impressions / 1000 * price' },
  ],
}

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

const COST = { name: 'Cost', formula: 'impressions / 1000 * price' }

const compiled = (fields: PayloadFieldsInput): CompiledFields =>
  compileFields(payloadFieldsSchema.parse(fields))

const scopes = (...entries: [string, ScopeCampaign[]][]) => new Map(entries)

describe('payloadFieldsSchema', () => {
  it('turns the one-source list into one campaign-level row set, defaults filled in', () => {
    expect(payloadFieldsSchema.parse(TCHIBO)).toEqual({
      columns: ['Ad Type', 'Impressions', 'Clicks', 'Cost'],
      rows: [
        {
          source: 'zeus',
          level: 'campaign',
          name: 'campaign',
          values: {
            'Ad Type': { value: 'Dynamic Ad' },
            Impressions: { formula: 'impressions', decimals: 0 },
            Clicks: { formula: 'clicks', decimals: 0 },
            Cost: { formula: 'impressions / 1000 * price', decimals: 2 },
          },
        },
      ],
    })
  })

  it('keeps row sets as given, defaults filled in and values in column order', () => {
    const parsed = payloadFieldsSchema.parse(TCHIBO_ROWS)
    expect(parsed.columns).toEqual(['Creative Format', 'Ad Type', 'Impressions', 'Clicks', 'Cost'])
    expect(parsed.rows.map((set) => [set.source, set.level, set.name])).toEqual([
      ['zeus', 'campaign', 'campaign'],
      ['nexd', 'creative', 'campaign'],
    ])
    expect(Object.keys(at(parsed.rows, 1).values)).toEqual([
      'Creative Format',
      'Ad Type',
      'Impressions',
      'Cost',
    ])
    expect(at(parsed.rows, 1).values.Cost).toEqual({
      formula: 'impressions / 1000 * price',
      decimals: 2,
    })
  })

  it('takes a column name exactly as the client writes it, trimmed', () => {
    const fields = payloadFieldsSchema.parse({
      source: 'nexd',
      columns: [{ name: '  Kosten (€), netto ', formula: 'impressions' }],
    })
    expect(fields.columns).toEqual(['Kosten (€), netto'])
    expect(at(fields.rows).source).toBe('nexd')
  })

  it.each<[string, unknown, RegExp]>([
    ['no columns at all', { columns: [] }, /columns/],
    ['a column with neither formula nor value', { columns: [{ name: 'X' }] }, /exactly one/],
    [
      'a column with both',
      { columns: [{ name: 'X', formula: 'impressions', value: 'a' }] },
      /exactly one/,
    ],
    ['decimals on a text', { columns: [{ name: 'X', value: 'a', decimals: 2 }] }, /rounded/],
    ['the Date column', { columns: [{ ...COST, name: 'Date' }] }, /fixed first columns/],
    ['Campaign in other case', { columns: [{ ...COST, name: 'campaign' }] }, /fixed first/],
    ['the Creative column', { columns: [{ ...COST, name: 'Creative' }] }, /fixed first/],
    ['the same name twice', { columns: [COST, COST] }, /defined twice/],
    ['a name twice in other case', { columns: [COST, { ...COST, name: 'COST' }] }, /twice/],
    ['a line break in a name', { columns: [{ ...COST, name: 'Co\nst' }] }, /control/],
    ['a line break in a text', { columns: [{ name: 'X', value: 'a\r\nb' }] }, /control/],
    ['an empty name', { columns: [{ ...COST, name: '   ' }] }, /name/],
    ['too many decimals', { columns: [{ ...COST, decimals: 7 }] }, /decimals/],
    ['a source that is not an id', { source: 'ATK', columns: [COST] }, /source/],
    ['an unknown key', { columns: [COST], metrics: ['impressions'] }, /metrics/],
    [
      'more than thirty columns',
      { columns: Array.from({ length: 31 }, (_, i) => ({ ...COST, name: `c${String(i)}` })) },
      /30/,
    ],
    ['row sets without a row set', { columns: ['Cost'], rows: [] }, /rows/],
    [
      'a value for a column that does not exist',
      { columns: ['Cost'], rows: [{ values: { Kosten: { formula: 'impressions' } } }] },
      /Kosten.* is not one of the columns/,
    ],
    [
      'a cell with nothing in it',
      { columns: ['Cost'], rows: [{ values: { Cost: {} } }] },
      /exactly one of \W*formula/,
    ],
    [
      'a cell with a formula and a variable',
      { columns: ['Cost'], rows: [{ values: { Cost: { formula: 'price', variable: 'source' } } }] },
      /exactly one/,
    ],
    [
      'a row variable that does not exist',
      { columns: ['Cost'], rows: [{ values: { Cost: { variable: 'campaign' } } }] },
      /variable/,
    ],
    [
      'a creative name on a campaign-level row set',
      { columns: ['Cost'], rows: [{ name: 'creative', values: {} }] },
      /needs \W*level\W*: \W*creative/,
    ],
    [
      'the Creative column in the row-set form',
      { columns: ['Creative'], rows: [{ values: {} }] },
      /fixed first/,
    ],
    [
      'a level that does not exist',
      { columns: ['Cost'], rows: [{ level: 'language', values: {} }] },
      /level/,
    ],
  ])('refuses %s', (_name, input, reason) => {
    const result = payloadFieldsSchema.safeParse(input)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(reason)
  })
})

describe('compileFields', () => {
  it('puts Date and Campaign first, then the columns in their order', () => {
    expect(compiled(TCHIBO).names).toEqual([
      'Date',
      'Campaign',
      'Ad Type',
      'Impressions',
      'Clicks',
      'Cost',
    ])
    expect(compiled(TCHIBO).creativeColumn).toBe(false)
  })

  it('adds Creative when a creative-level row set keeps the campaign in Campaign', () => {
    const fields = compiled(TCHIBO_ROWS)
    expect(fields.names).toEqual([
      'Date',
      'Campaign',
      'Creative',
      'Creative Format',
      'Ad Type',
      'Impressions',
      'Clicks',
      'Cost',
    ])
    expect(fields.creativeColumn).toBe(true)
    expect(fields.sources).toEqual(['zeus', 'nexd'])
    expect(fields.waitSource).toBe('zeus')
  })

  it('needs no Creative column when every creative-level row set is named after its creative', () => {
    const fields = compiled({
      columns: ['Impressions'],
      rows: [
        { source: 'zeus', values: { Impressions: { formula: 'impressions' } } },
        {
          source: 'nexd',
          level: 'creative',
          name: 'creative',
          values: { Impressions: { formula: 'impressions' } },
        },
      ],
    })
    expect(fields.names).toEqual(['Date', 'Campaign', 'Impressions'])
    expect(fields.creativeColumn).toBe(false)
  })

  it('compiles one cell per column per row set, empty where the row set binds nothing', () => {
    const [zeus, nexd] = compiled(TCHIBO_ROWS).rowSets
    expect(zeus?.cells.map((cell) => cell.kind)).toEqual([
      'empty',
      'text',
      'formula',
      'formula',
      'formula',
    ])
    expect(nexd?.cells.map((cell) => cell.kind)).toEqual([
      'text',
      'text',
      'formula',
      'empty',
      'formula',
    ])
    expect([zeus?.usesClicks, nexd?.usesClicks]).toEqual([true, false])
    expect([zeus?.usesPrice, nexd?.usesPrice]).toEqual([true, true])
  })

  it('names the column and the character when a formula does not parse', () => {
    expect(() => compiled({ columns: [{ name: 'Cost', formula: 'impressions /' }] })).toThrow(
      'column "Cost": formula ends where a number, a variable or "(" should follow',
    )
    expect(() => compiled({ columns: [{ name: 'Cost', formula: 'impressions ) 2' }] })).toThrow(
      'column "Cost": unexpected ")" at 13',
    )
    expect(() =>
      compiled({ columns: ['Cost'], rows: [{ values: { Cost: { formula: 'price *' } } }] }),
    ).toThrow(/^column "Cost": formula ends/)
  })

  it('refuses a variable that does not exist', () => {
    expect(() =>
      compiled({ columns: [{ name: 'Cost', formula: 'impresions / 1000 * price' }] }),
    ).toThrow(/unknown variable "impresions"/)
    // Names an object would have are not variables either.
    expect(() => compiled({ columns: [{ name: 'X', formula: 'constructor * 2' }] })).toThrow(
      InvalidFormulaError,
    )
  })

  it('knows which reads its formulas need', () => {
    const fields = compiled(TCHIBO)
    expect(at(fields.rowSets).usesPrice).toBe(true)
    expect(at(fields.rowSets).usesClicks).toBe(true)
    expect(metricsRead(fields)).toEqual(['impressions'])

    const text = compiled({ columns: [{ name: 'Ad Type', value: 'Dynamic Ad' }] })
    expect(at(text.rowSets).usesPrice).toBe(false)
    expect(at(text.rowSets).usesClicks).toBe(false)
    expect(metricsRead(text)).toEqual([])
  })
})

describe('readStoredFields', () => {
  it('reads a stored list back to the same columns, in either form', () => {
    for (const input of [TCHIBO, TCHIBO_ROWS]) {
      const stored = JSON.parse(JSON.stringify(payloadFieldsSchema.parse(input))) as unknown
      expect(readStoredFields(stored).names).toEqual(compiled(input).names)
    }
  })

  it('refuses a webhook without a column list', () => {
    expect(() => readStoredFields(null)).toThrow(InvalidWebhookError)
    expect(() => readStoredFields(undefined)).toThrow(/needs a column list/)
  })

  it('refuses a version 1 field list, and a row edited by hand', () => {
    expect(() => readStoredFields({ metrics: ['impressions'], calculated: [] })).toThrow(
      InvalidWebhookError,
    )
    expect(() => readStoredFields({ columns: 'Cost' })).toThrow(/column list schema/)
    expect(() => readStoredFields({ columns: ['Cost'], rows: 'zeus' })).toThrow(
      /column list schema/,
    )
  })
})

describe('validateFields', () => {
  const catalog = fakeDb((text) =>
    text.includes('FROM external.source s')
      ? [
          { source_id: 'nexd', metrics: ['impressions', 'dwell_avg_ms', 'cta_counter'] },
          { source_id: 'zeus', metrics: ['impressions', 'in_view', 'cta_counter'] },
          { source_id: 'brame', metrics: [] },
        ]
      : [],
  )
  const validate = (fields: PayloadFieldsInput) =>
    validateFields(catalog.db, payloadFieldsSchema.parse(fields))

  it('accepts formulas its sources can compute', async () => {
    await expect(validate(TCHIBO)).resolves.toMatchObject({ sources: ['zeus'] })
    await expect(validate(TCHIBO_ROWS)).resolves.toMatchObject({ sources: ['zeus', 'nexd'] })
  })

  it('refuses a metric the source does not measure: the column could never have a value', async () => {
    await expect(
      validate({ columns: [{ name: 'Dwell', formula: 'dwell_avg_ms / 1000' }] }),
    ).rejects.toThrow('column "Dwell": zeus does not measure dwell_avg_ms')
  })

  it("checks each row set against its own source, not the first one's", async () => {
    await expect(
      validate({
        columns: ['Dwell'],
        rows: [
          { source: 'nexd', values: { Dwell: { formula: 'dwell_avg_ms' } } },
          { source: 'zeus', level: 'creative', values: { Dwell: { formula: 'dwell_avg_ms' } } },
        ],
      }),
    ).rejects.toThrow('column "Dwell": zeus does not measure dwell_avg_ms')
  })

  it('refuses clicks from a source that measures no CTA clicks', async () => {
    await expect(
      validate({ source: 'brame', columns: [{ name: 'CTR', formula: 'clicks / impressions' }] }),
    ).rejects.toThrow(/brame does not measure clicks/)
  })

  it('refuses an unknown source and says which exist', async () => {
    await expect(validate({ source: 'adnuntius', columns: [COST] })).rejects.toThrow(
      /unknown source "adnuntius"; one of nexd, zeus, brame/,
    )
  })

  it('checks the source even when every column is a text', async () => {
    await expect(
      validate({ source: 'adnuntius', columns: [{ name: 'Ad Type', value: 'Dynamic Ad' }] }),
    ).rejects.toThrow(InvalidWebhookError)
  })
})

describe('fieldWarnings', () => {
  it('names the campaigns not linked to the source, and the linked ones without a price', () => {
    const warnings = fieldWarnings(
      compiled(TCHIBO),
      scopes([
        'zeus',
        [
          { name: 'Priced', hasPrice: true, linked: true },
          { name: 'Unpriced', hasPrice: false, linked: true },
          { name: 'NEXD only', hasPrice: false, linked: false },
        ],
      ]),
    )
    expect(warnings).toEqual([
      'these campaigns are not linked to zeus, so they have no rows until they are: NEXD only',
      'these campaigns have no price, so Cost will be empty for them until one is set: Unpriced',
    ])
  })

  it('warns per source, naming only the columns of that source that read the price', () => {
    const warnings = fieldWarnings(
      compiled(TCHIBO_ROWS),
      scopes(
        ['zeus', [{ name: 'Always-On', hasPrice: false, linked: true }]],
        ['nexd', [{ name: 'Always-On', hasPrice: false, linked: false }]],
      ),
    )
    expect(warnings).toEqual([
      'these campaigns have no price, so Cost will be empty for them until one is set: Always-On',
      'these campaigns are not linked to nexd, so they have no rows until they are: Always-On',
    ])
  })

  it('says nothing about a price no formula uses', () => {
    expect(
      fieldWarnings(
        compiled({ columns: [{ name: 'Impressions', formula: 'impressions' }] }),
        scopes(['zeus', [{ name: 'Unpriced', hasPrice: false, linked: true }]]),
      ),
    ).toEqual([])
  })

  it('shortens a long list of campaigns', () => {
    const scope = Array.from({ length: 13 }, (_, i) => ({
      name: `C${String(i)}`,
      hasPrice: false,
      linked: true,
    }))
    expect(at(fieldWarnings(compiled(TCHIBO), scopes(['zeus', scope])))).toMatch(/C9 and 3 more$/)
  })
})
