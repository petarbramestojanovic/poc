import { describe, expect, it } from 'vitest'
import { renderCsv } from '../../src/modules/webhooks/csv.ts'
import {
  renderDocument,
  renderJson,
  reportBodySchema,
  reportBodySchemaFor,
  type Envelope,
} from '../../src/modules/webhooks/payload.ts'
import type { ReportRow } from '../../src/modules/webhooks/rows.ts'

// The two documents a report becomes (docs/WEBHOOK-PAYLOAD-v2.md). Both are rendered by hand, so
// the columns come out in the client's order — even a column named like a number, which a
// JavaScript object or a jsonb value would move to the front.

const ENVELOPE: Envelope = {
  deliveryId: '9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1',
  generatedAt: new Date('2026-10-09T03:00:02.417Z'),
  period: { from: '2026-10-08', to: '2026-10-08' },
  timezone: 'Europe/Zurich',
  frequency: 'daily',
}

const NAMES = ['Date', 'Campaign', 'Ad Type', 'Impressions', 'Clicks', 'Cost']
const ROWS: ReportRow[] = [
  ['2026-10-08', 'DE2610 Tchibo Caffè Crema', 'Dynamic Ad', 120345, 812, 1875.99],
  ['2026-10-08', 'AT2610 Tchibo "Barista", Edition', 'Dynamic Ad', 900, null, null],
]

describe('renderJson', () => {
  it('writes the envelope and the rows, keys in column order, as one exact text', () => {
    expect(renderJson(ENVELOPE, NAMES, ROWS.slice(0, 1))).toBe(
      '{"version":2,"delivery_id":"9c9f2f2a-6c1e-4a61-9d1a-4a3a5e2b77d1",' +
        '"generated_at":"2026-10-09T03:00:02Z",' +
        '"period":{"start":"2026-10-08","end":"2026-10-08","timezone":"Europe/Zurich","frequency":"daily"},' +
        '"rows":[{"Date":"2026-10-08","Campaign":"DE2610 Tchibo Caffè Crema","Ad Type":"Dynamic Ad",' +
        '"Impressions":120345,"Clicks":812,"Cost":1875.99}]}',
    )
  })

  it('keeps a column named like a number where the client put it', () => {
    const text = renderJson(
      ENVELOPE,
      ['Date', 'Campaign', 'Cost', '2026'],
      [['2026-10-08', 'X', 1, 2]],
    )
    expect(text).toContain('{"Date":"2026-10-08","Campaign":"X","Cost":1,"2026":2}')
  })

  it('writes a missing value as null and an empty report as no rows', () => {
    expect(renderJson(ENVELOPE, NAMES, ROWS)).toContain('"Clicks":null,"Cost":null}')
    expect(renderJson({ ...ENVELOPE, deliveryId: null }, NAMES, [])).toMatch(
      /"delivery_id":null,.*"rows":\[\]\}$/,
    )
  })

  it('is what the published contract describes', () => {
    const body: unknown = JSON.parse(renderJson(ENVELOPE, NAMES, ROWS))
    expect(reportBodySchema.parse(body).rows).toHaveLength(2)
    expect(reportBodySchemaFor(NAMES).safeParse(body).success).toBe(true)
  })
})

describe('reportBodySchemaFor', () => {
  const body = (row: Record<string, unknown>) => ({
    version: 2,
    delivery_id: null,
    generated_at: '2026-10-09T03:00:02Z',
    period: { start: '2026-10-08', end: '2026-10-08', timezone: 'UTC', frequency: 'daily' },
    rows: [row],
  })
  const schema = reportBodySchemaFor(['Date', 'Campaign', 'Cost'])

  it('refuses a key the column list does not have, and a missing one', () => {
    expect(
      schema.safeParse(body({ Date: '2026-10-08', Campaign: 'X', Cost: 1, Extra: 2 })).success,
    ).toBe(false)
    expect(schema.safeParse(body({ Date: '2026-10-08', Campaign: 'X' })).success).toBe(false)
  })

  it('refuses a date that is not a calendar day', () => {
    expect(schema.safeParse(body({ Date: '2026-02-31', Campaign: 'X', Cost: 1 })).success).toBe(
      false,
    )
  })

  it('refuses another version', () => {
    expect(reportBodySchema.safeParse({ ...body({}), version: 1 }).success).toBe(false)
  })
})

describe('renderCsv', () => {
  it('writes a header and one line per row, CRLF, quoting only what has to be', () => {
    expect(renderCsv(NAMES, ROWS)).toBe(
      'Date,Campaign,Ad Type,Impressions,Clicks,Cost\r\n' +
        '2026-10-08,DE2610 Tchibo Caffè Crema,Dynamic Ad,120345,812,1875.99\r\n' +
        '2026-10-08,"AT2610 Tchibo ""Barista"", Edition",Dynamic Ad,900,,\r\n',
    )
  })

  it('quotes a header with a comma, and a cell with a line break or edge spaces', () => {
    expect(
      renderCsv(
        ['Date', 'Kosten, netto'],
        [
          ['2026-10-08', ' a'],
          ['2026-10-09', 'b\nc'],
        ],
      ),
    ).toBe('Date,"Kosten, netto"\r\n2026-10-08," a"\r\n2026-10-09,"b\nc"\r\n')
  })

  it('writes a number as the JSON body does', () => {
    expect(renderCsv(['N'], [[0.1], [-3], [1500]])).toBe('N\r\n0.1\r\n-3\r\n1500\r\n')
  })

  it('is what renderDocument gives a csv webhook', () => {
    expect(renderDocument('csv', ENVELOPE, NAMES, ROWS)).toBe(renderCsv(NAMES, ROWS))
    expect(renderDocument('json', ENVELOPE, NAMES, ROWS)).toBe(renderJson(ENVELOPE, NAMES, ROWS))
  })
})
