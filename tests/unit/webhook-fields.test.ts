import { describe, expect, it } from 'vitest'
import { InvalidFormulaError, InvalidWebhookError } from '../../src/modules/webhooks/errors.ts'
import {
  clicksKey,
  compileFields,
  dayKey,
  fieldWarnings,
  payloadFieldsSchema,
  payloadShapeOf,
  readStoredFields,
  shapePayload,
  validateFields,
  type CompiledFields,
  type PayloadFieldsInput,
  type ShapeInputs,
  type SourceClicks,
} from '../../src/modules/webhooks/fields.ts'
import { parseDecimal } from '../../src/modules/webhooks/formula.ts'
import {
  webhookPayloadSchema,
  webhookPayloadSchemaFor,
  type WebhookPayload,
} from '../../src/modules/webhooks/payload.ts'
import { at } from '../helpers.ts'
import { fakeDb } from './webhook-fakes.ts'

// A webhook's field list: what it refuses, and the body it makes. The fixture is a campaign whose
// primary source is NEXD with Zeus as a check, so "cost comes from Zeus" and "cost never appears
// twice" can both be broken.

const CAMPAIGN = '00000000-0000-4000-8000-000000000002'

const compiled = (fields: PayloadFieldsInput): CompiledFields =>
  compileFields(payloadFieldsSchema.parse(fields))

const COST = { name: 'cost', formula: 'impressions / 1000 * price' }

/** A full v1 body: NEXD primary, Zeus check, two Zeus days of 1001 impressions and a creative. */
function fullBody(): WebhookPayload {
  return webhookPayloadSchema.parse({
    version: 1,
    delivery_id: null,
    generated_at: '2026-09-14T06:00:02Z',
    period: {
      start: '2026-09-07',
      end: '2026-09-13',
      timezone: 'Europe/Zurich',
      window: 'previous_week',
    },
    company: { id: '00000000-0000-4000-8000-000000000001', name: 'Tchibo' },
    campaigns: [
      {
        id: CAMPAIGN,
        name: 'AT2608 Tchibo Caffè Crema',
        primary_source: 'nexd',
        sources: [
          {
            source: 'nexd',
            display_name: 'NEXD',
            role: 'primary',
            day_timezone: 'UTC',
            data_complete_through: '2026-09-13',
            last_synced_at: '2026-09-14T02:05:36Z',
            metrics_available: ['cta_counter', 'dwell_avg_ms', 'impressions', 'view_counter'],
            totals: { impressions: 1200, dwell_avg_ms: 8158.21 },
            daily: [
              { date: '2026-09-07', language: 'de', impressions: 1200, dwell_avg_ms: 8158.21 },
            ],
            creatives: [],
            ctas: [
              { cta_id: 'clickthrough', name: 'Click-out', is_internal_event: false, count: 4 },
            ],
            pages: [{ page_id: 'main', name: 'Main', count: 9 }],
          },
          {
            source: 'zeus',
            display_name: 'ATK (Zeus)',
            role: 'check',
            day_timezone: 'UTC',
            data_complete_through: '2026-09-13',
            last_synced_at: '2026-09-14T02:04:11Z',
            metrics_available: ['cta_counter', 'impressions', 'in_view', 'unique_clicks_reported'],
            totals: { impressions: 2002, in_view: 1700, unique_clicks_reported: null },
            daily: [
              {
                date: '2026-09-07',
                language: 'de',
                impressions: 1001,
                in_view: 800,
                unique_clicks_reported: 9,
              },
              {
                date: '2026-09-08',
                language: 'de',
                impressions: 1001,
                in_view: 900,
                unique_clicks_reported: 20,
              },
            ],
            creatives: [
              {
                campaign_tag: 'mpu_v1',
                label: 'MPU V1',
                totals: { impressions: 2002, in_view: 1700, unique_clicks_reported: null },
              },
            ],
            ctas: [
              { cta_id: 'clickthrough', name: 'Click-out', is_internal_event: false, count: 40 },
            ],
            pages: [],
          },
        ],
      },
    ],
  })
}

const priced: ShapeInputs = {
  prices: new Map([[CAMPAIGN, { value: '15.5876', currency: 'EUR' }]]),
  clicks: new Map(),
}

type Json = Record<string, unknown>
const campaignOf = (body: Json) => at(body.campaigns as Json[])
const blockOf = (body: Json, source: string) => {
  const block = (campaignOf(body).sources as Json[]).find((entry) => entry.source === source)
  if (!block) throw new Error(`no ${source} block`)
  return block
}

describe('payloadFieldsSchema', () => {
  it('fills in the source and the decimals', () => {
    expect(payloadFieldsSchema.parse({ calculated: [COST] })).toEqual({
      calculated: [{ ...COST, source: 'zeus', decimals: 2 }],
    })
  })

  it.each<[string, unknown, RegExp]>([
    ['a metric twice', { metrics: ['impressions', 'impressions'] }, /listed twice/],
    ['an unknown metric', { metrics: ['clicks'] }, /metrics/],
    ['an unknown section', { sections: ['creatives'] }, /sections/],
    ['a name taken by a metric', { calculated: [{ ...COST, name: 'impressions' }] }, /already/],
    ['a name taken by a variable', { calculated: [{ ...COST, name: 'price' }] }, /already/],
    ['a reserved key', { calculated: [{ ...COST, name: 'date' }] }, /already/],
    ['the same name twice', { calculated: [COST, COST] }, /defined twice/],
    ['a name with capitals', { calculated: [{ ...COST, name: 'Cost' }] }, /lowercase/],
    ['too many decimals', { calculated: [{ ...COST, decimals: 7 }] }, /decimals/],
    ['a source that is not an id', { calculated: [{ ...COST, source: 'ATK' }] }, /source/],
    ['an unknown key', { calculated: [], extra: true }, /extra/],
    [
      'more than twenty fields',
      { calculated: Array.from({ length: 21 }, (_, i) => ({ ...COST, name: `f${i}` })) },
      /20/,
    ],
  ])('refuses %s', (_name, input, reason) => {
    const result = payloadFieldsSchema.safeParse(input)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(reason)
  })
})

describe('compileFields', () => {
  it('names the field and the character when a formula does not parse', () => {
    expect(() => compiled({ calculated: [{ name: 'cost', formula: 'impressions /' }] })).toThrow(
      'calculated field "cost": formula ends where a number, a variable or "(" should follow',
    )
    expect(() => compiled({ calculated: [{ name: 'cost', formula: 'impressions ) 2' }] })).toThrow(
      'calculated field "cost": unexpected ")" at 13',
    )
  })

  it('refuses a variable that does not exist', () => {
    expect(() =>
      compiled({ calculated: [{ name: 'cost', formula: 'impresions / 1000 * price' }] }),
    ).toThrow(/unknown variable "impresions"/)
    // Names an object would have are not variables either.
    expect(() => compiled({ calculated: [{ name: 'x', formula: 'constructor * 2' }] })).toThrow(
      InvalidFormulaError,
    )
  })

  it('knows which campaign reads it will need', () => {
    const fields = compiled({
      calculated: [COST, { name: 'ctr', formula: 'clicks / impressions', source: 'nexd' }],
    })
    expect(fields.usesPrice).toBe(true)
    expect(fields.clickSources).toEqual(['nexd'])
    expect(compiled({}).usesPrice).toBe(false)
  })
})

describe('readStoredFields', () => {
  it('reads no field list as the full body', () => {
    expect(readStoredFields(null)).toBeNull()
    expect(readStoredFields(undefined)).toBeNull()
  })

  it('refuses a row edited by hand into something the schema does not know', () => {
    expect(() => readStoredFields({ calculated: 'cost' })).toThrow(InvalidWebhookError)
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

  it('accepts a formula its source can compute', async () => {
    await expect(validate({ calculated: [COST] })).resolves.toMatchObject({ usesPrice: true })
  })

  it('refuses a metric the source does not measure: the field could never have a value', async () => {
    await expect(
      validate({ calculated: [{ name: 'dwell_s', formula: 'dwell_avg_ms / 1000' }] }),
    ).rejects.toThrow('calculated field "dwell_s": zeus does not measure dwell_avg_ms')
  })

  it('refuses clicks from a source that measures no CTA clicks', async () => {
    await expect(
      validate({ calculated: [{ name: 'ctr', formula: 'clicks / impressions', source: 'brame' }] }),
    ).rejects.toThrow(/brame does not measure clicks/)
  })

  it('refuses an unknown source and says which exist', async () => {
    await expect(validate({ calculated: [{ ...COST, source: 'adnuntius' }] })).rejects.toThrow(
      /unknown source "adnuntius"; one of nexd, zeus, brame/,
    )
  })

  it('does not ask the database when nothing is calculated', async () => {
    const empty = fakeDb()
    await validateFields(empty.db, payloadFieldsSchema.parse({ metrics: ['impressions'] }))
    expect(empty.queries).toEqual([])
  })
})

describe('fieldWarnings', () => {
  it('names the campaigns without a price, and those not linked to the source', () => {
    const warnings = fieldWarnings(compiled({ calculated: [COST] }), [
      { name: 'Priced', hasPrice: true, sources: ['zeus'] },
      { name: 'Unpriced', hasPrice: false, sources: ['zeus'] },
      { name: 'NEXD only', hasPrice: true, sources: ['nexd'] },
    ])
    expect(warnings).toEqual([
      'these campaigns have no price, so cost will be null for them until one is set: Unpriced',
      'these campaigns are not linked to zeus, so cost will carry no value for them: NEXD only',
    ])
  })

  it('says nothing when every campaign can be computed', () => {
    expect(
      fieldWarnings(compiled({ calculated: [COST] }), [
        { name: 'Priced', hasPrice: true, sources: ['zeus', 'nexd'] },
      ]),
    ).toEqual([])
  })

  it('shortens a long list of campaigns', () => {
    const scope = Array.from({ length: 13 }, (_, i) => ({
      name: `C${i}`,
      hasPrice: false,
      sources: ['zeus'],
    }))
    expect(at(fieldWarnings(compiled({ calculated: [COST] }), scope))).toMatch(/C9 and 3 more$/)
  })
})

describe('shapePayload', () => {
  const shape = (fields: PayloadFieldsInput, inputs: ShapeInputs = priced) => {
    const compiledFields = compiled(fields)
    const body = shapePayload(fullBody(), compiledFields, inputs)
    // Every body a field list produces is one its own contract accepts.
    webhookPayloadSchemaFor(payloadShapeOf(compiledFields)).parse(body)
    return body
  }

  it('computes cost at every level from that level, in the source it names only', () => {
    const body = shape({ calculated: [COST] })
    const zeus = blockOf(body, 'zeus')
    const nexd = blockOf(body, 'nexd')

    // 2002 / 1000 × 15.5876 = 31.2063752 → 31.21, not the sum of the rounded days (31.20).
    expect((zeus.totals as Json).cost).toBe(31.21)
    expect((zeus.daily as Json[]).map((day) => day.cost)).toEqual([15.6, 15.6])
    expect((at(zeus.creatives as Json[]).totals as Json).cost).toBe(31.21)
    expect(zeus.metrics_available).toEqual([
      'cta_counter',
      'impressions',
      'in_view',
      'unique_clicks_reported',
      'cost',
    ])
    // Never a second cost from the other source.
    expect(nexd.totals as Json).not.toHaveProperty('cost')
    expect(nexd.metrics_available).not.toContain('cost')
  })

  it('carries the price and its currency beside a cost', () => {
    expect(campaignOf(shape({ calculated: [COST] }))).toMatchObject({
      price: 15.5876,
      currency: 'EUR',
    })
  })

  it('gives a campaign without a price a null cost, never 0', () => {
    const body = shape(
      { calculated: [COST] },
      {
        prices: new Map([[CAMPAIGN, { value: null, currency: null }]]),
        clicks: new Map(),
      },
    )
    expect(campaignOf(body)).toMatchObject({ price: null, currency: null })
    expect((blockOf(body, 'zeus').totals as Json).cost).toBeNull()
  })

  it('leaves the price out when no formula uses it', () => {
    const body = shape({ calculated: [{ name: 'half', formula: 'impressions / 2' }] })
    expect(campaignOf(body)).not.toHaveProperty('price')
    expect(campaignOf(body)).not.toHaveProperty('currency')
  })

  it('computes from a metric it does not deliver', () => {
    const body = shape({ metrics: ['in_view'], calculated: [COST] })
    const totals = blockOf(body, 'zeus').totals as Json
    expect(totals).toEqual({ in_view: 1700, cost: 31.21 })
    expect(blockOf(body, 'zeus').metrics_available).toEqual(['cta_counter', 'in_view', 'cost'])
  })

  it('keeps an unmeasured metric absent, not null', () => {
    const totals = blockOf(shape({ metrics: ['dwell_avg_ms'] }), 'zeus').totals as Json
    expect(totals).toEqual({})
  })

  it('drops the lists it does not want, and their catalog entries', () => {
    const body = shape({ sections: ['daily'] })
    const nexd = blockOf(body, 'nexd')
    expect(nexd).toHaveProperty('daily')
    expect(nexd).not.toHaveProperty('ctas')
    expect(nexd).not.toHaveProperty('pages')
    expect(nexd.metrics_available).toEqual(['dwell_avg_ms', 'impressions'])
  })

  it('computes clicks per level and gives null where a level has none', () => {
    const clicks: SourceClicks = {
      total: parseDecimal('40'),
      daily: new Map([[dayKey('2026-09-07', 'de'), parseDecimal('10')]]),
      creatives: new Map([['mpu_v1', parseDecimal('40')]]),
    }
    const body = shape(
      { calculated: [{ name: 'ctr', formula: 'clicks / impressions', decimals: 4 }] },
      { prices: new Map(), clicks: new Map([[clicksKey(CAMPAIGN, 'zeus'), clicks]]) },
    )
    const zeus = blockOf(body, 'zeus')
    expect((zeus.totals as Json).ctr).toBe(0.02) // 40 / 2002 = 0.01998…
    expect((zeus.daily as Json[]).map((day) => day.ctr)).toEqual([0.01, null])
  })

  it('does not touch the body it was given', () => {
    const body = fullBody()
    const before = JSON.stringify(body)
    shapePayload(body, compiled({ metrics: [], calculated: [COST] }), priced)
    expect(JSON.stringify(body)).toBe(before)
  })
})
