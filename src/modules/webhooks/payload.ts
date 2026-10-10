import { z } from 'zod'
import type { DateWindow } from '../../core/dates.ts'
import { renderCsv } from './csv.ts'
import { FREQUENCIES, type Frequency } from './periods.ts'
import type { ReportRow } from './rows.ts'

// The report a webhook delivers, version 2 (docs/WEBHOOK-PAYLOAD-v2.md): flat rows, one per
// campaign and day, `Date` and `Campaign` first and then the webhook's own columns. Two formats:
//
//   json  the rows inside a small envelope, POSTed as the signed body
//   csv   the same rows as a CSV file, served at a signed link that is POSTed instead (exports.ts)
//
// Either way the document is rendered ONCE, here, and stored as text in app.webhook_delivery.payload:
// what is signed, sent and served later is exactly that text. Rendering by hand keeps the columns in
// the order the client asked for — a JavaScript object (and a jsonb value) would move a name such as
// "2026" to the front.

export const PAYLOAD_VERSION = 2

export const FORMATS = ['json', 'csv'] as const
export type Format = (typeof FORMATS)[number]

export interface Envelope {
  /** app.webhook_delivery.id, the same value as the X-Delivery-Id header; null in a preview. */
  deliveryId: string | null
  generatedAt: Date
  period: DateWindow
  /** The webhook's timezone, in which the period was a whole day, week or month. */
  timezone: string
  frequency: Frequency
}

export function renderDocument(
  format: Format,
  envelope: Envelope,
  names: readonly string[],
  rows: readonly ReportRow[],
): string {
  return format === 'csv' ? renderCsv(names, rows) : renderJson(envelope, names, rows)
}

export function renderJson(
  envelope: Envelope,
  names: readonly string[],
  rows: readonly ReportRow[],
): string {
  const head = JSON.stringify({
    version: PAYLOAD_VERSION,
    delivery_id: envelope.deliveryId,
    generated_at: envelope.generatedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    period: {
      start: envelope.period.from,
      end: envelope.period.to,
      timezone: envelope.timezone,
      frequency: envelope.frequency,
    },
  })
  const body = rows.map((row) => rowJson(names, row)).join(',')
  return `${head.slice(0, -1)},"rows":[${body}]}`
}

function rowJson(names: readonly string[], row: ReportRow): string {
  const pairs = names.map(
    (name, index) => `${JSON.stringify(name)}:${JSON.stringify(row[index] ?? null)}`,
  )
  return `{${pairs.join(',')}}`
}

const cell = z.union([z.string(), z.number(), z.null()])

/** The JSON body, whatever its columns. The contract test parses real bodies with it. */
export const reportBodySchema = z.strictObject({
  version: z.literal(PAYLOAD_VERSION),
  delivery_id: z.guid().nullable(),
  generated_at: z.iso.datetime(),
  period: z.strictObject({
    start: z.iso.date(),
    end: z.iso.date(),
    timezone: z.string(),
    frequency: z.enum(FREQUENCIES),
  }),
  rows: z.array(z.record(z.string(), cell)),
})
export type ReportBody = z.infer<typeof reportBodySchema>

/** The JSON body of one column list: exactly these keys in every row, Date and Campaign as text. */
export function reportBodySchemaFor(names: readonly string[]): z.ZodType {
  const [date, campaign, ...columns] = names
  const shape: Record<string, z.ZodType> = Object.fromEntries(columns.map((name) => [name, cell]))
  if (date !== undefined) shape[date] = z.iso.date()
  if (campaign !== undefined) shape[campaign] = z.string()
  return reportBodySchema.extend({ rows: z.array(z.strictObject(shape)) })
}
