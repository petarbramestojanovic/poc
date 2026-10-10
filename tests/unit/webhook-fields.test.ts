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
} from '../../src/modules/webhooks/fields.ts'
import { at } from '../helpers.ts'
import { fakeDb } from './webhook-fakes.ts'

// A webhook's column list: what it refuses, and what it compiles to. Tchibo's Funnel sheet is the
// fixture: Date, Campaign, then a fixed "Ad Type", impressions, clicks and a cost.

const TCHIBO: PayloadFieldsInput = {
  columns: [
    { name: 'Ad Type', value: 'Dynamic Ad' },
    { name: 'Impressions', formula: 'impressions', decimals: 0 },
    { name: 'Clicks', formula: 'clicks', decimals: 0 },
    { name: 'Cost', formula: 'impressions / 1000 * price' },
  ],
}

const COST = { name: 'Cost', formula: 'impressions / 1000 * price' }

const compiled = (fields: PayloadFieldsInput): CompiledFields =>
  compileFields(payloadFieldsSchema.parse(fields))

describe('payloadFieldsSchema', () => {
  it('fills in the source and the decimals, and keeps the columns in order', () => {
    expect(payloadFieldsSchema.parse(TCHIBO)).toEqual({
      source: 'zeus',
      columns: [
        { name: 'Ad Type', value: 'Dynamic Ad' },
        { name: 'Impressions', formula: 'impressions', decimals: 0 },
        { name: 'Clicks', formula: 'clicks', decimals: 0 },
        { name: 'Cost', formula: 'impressions / 1000 * price', decimals: 2 },
      ],
    })
  })

  it('takes a column name exactly as the client writes it, trimmed', () => {
    const fields = payloadFieldsSchema.parse({
      source: 'nexd',
      columns: [{ name: '  Kosten (€), netto ', formula: 'impressions' }],
    })
    expect(at(fields.columns).name).toBe('Kosten (€), netto')
    expect(fields.source).toBe('nexd')
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
    ['the Date column', { columns: [{ ...COST, name: 'Date' }] }, /first two columns/],
    ['Campaign in other case', { columns: [{ ...COST, name: 'campaign' }] }, /first two/],
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
  })

  it('names the column and the character when a formula does not parse', () => {
    expect(() => compiled({ columns: [{ name: 'Cost', formula: 'impressions /' }] })).toThrow(
      'column "Cost": formula ends where a number, a variable or "(" should follow',
    )
    expect(() => compiled({ columns: [{ name: 'Cost', formula: 'impressions ) 2' }] })).toThrow(
      'column "Cost": unexpected ")" at 13',
    )
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
    expect(fields.usesPrice).toBe(true)
    expect(fields.usesClicks).toBe(true)
    expect(metricsRead(fields)).toEqual(['impressions'])

    const text = compiled({ columns: [{ name: 'Ad Type', value: 'Dynamic Ad' }] })
    expect(text.usesPrice).toBe(false)
    expect(text.usesClicks).toBe(false)
    expect(metricsRead(text)).toEqual([])
  })
})

describe('readStoredFields', () => {
  it('reads a stored list back to the same columns', () => {
    const stored = JSON.parse(JSON.stringify(payloadFieldsSchema.parse(TCHIBO))) as unknown
    expect(readStoredFields(stored).names).toEqual(compiled(TCHIBO).names)
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

  it('accepts formulas its source can compute', async () => {
    await expect(validate(TCHIBO)).resolves.toMatchObject({ usesPrice: true, source: 'zeus' })
  })

  it('refuses a metric the source does not measure: the column could never have a value', async () => {
    await expect(
      validate({ columns: [{ name: 'Dwell', formula: 'dwell_avg_ms / 1000' }] }),
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
    const warnings = fieldWarnings(compiled(TCHIBO), [
      { name: 'Priced', hasPrice: true, linked: true },
      { name: 'Unpriced', hasPrice: false, linked: true },
      { name: 'NEXD only', hasPrice: false, linked: false },
    ])
    expect(warnings).toEqual([
      'these campaigns are not linked to zeus, so they have no rows until they are: NEXD only',
      'these campaigns have no price, so Cost will be empty for them until one is set: Unpriced',
    ])
  })

  it('says nothing about a price no formula uses', () => {
    expect(
      fieldWarnings(compiled({ columns: [{ name: 'Impressions', formula: 'impressions' }] }), [
        { name: 'Unpriced', hasPrice: false, linked: true },
      ]),
    ).toEqual([])
  })

  it('shortens a long list of campaigns', () => {
    const scope = Array.from({ length: 13 }, (_, i) => ({
      name: `C${String(i)}`,
      hasPrice: false,
      linked: true,
    }))
    expect(at(fieldWarnings(compiled(TCHIBO), scope))).toMatch(/C9 and 3 more$/)
  })
})
