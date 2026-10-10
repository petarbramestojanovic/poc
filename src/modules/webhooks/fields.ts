import { z } from 'zod'
import type { Queryable } from '../../core/db.ts'
import { loadSql } from '../../core/sql-file.ts'
import { METRIC_IDS, type MetricId } from '../sync/types.ts'
import { InvalidFormulaError, InvalidWebhookError } from './errors.ts'
import { MAX_FORMULA_LENGTH, parseFormula, variablesOf, type Expr } from './formula.ts'

// What one webhook delivers (app.webhook.payload_fields). A Brame admin agrees it with the client
// and enters it; the client never sees this config, only the rows it produces.
//
// Every row is one campaign on one day, from ONE source. Two columns are always there and always
// first: `Date` and `Campaign` (the campaign's name). Every other column is entered here, in the
// order the client wants, under the exact name the client wants:
//
//   { "source": "zeus",
//     "columns": [ { "name": "Ad Type",     "value": "Dynamic Ad" },                  fixed text
//                  { "name": "Impressions", "formula": "impressions", "decimals": 0 },
//                  { "name": "Cost",        "formula": "impressions / 1000 * price" } ] }
//
// A formula (formula.ts) reads that row's own numbers: a stored metric, `clicks` (non-internal CTA
// clicks) or `price` (the campaign's CPM). It is computed for each row from that row, never by
// adding up other results. A variable without a value, or a division by zero, makes it null —
// never 0.

const sql = loadSql(import.meta.url, ['source_metrics', 'fields_scope'] as const)

/** The two columns every row starts with, in this order. */
export const DATE_COLUMN = 'Date'
export const CAMPAIGN_COLUMN = 'Campaign'
export const FIXED_COLUMNS: readonly string[] = [DATE_COLUMN, CAMPAIGN_COLUMN]

/** The campaign's CPM (app.campaign.price, migration 0005), in the campaign's currency. */
export const PRICE_VARIABLE = 'price'
/** Non-internal CTA clicks of the row (analytics.cta_clicks), in the webhook's source. */
export const CLICKS_VARIABLE = 'clicks'

/** Every name a formula may use. */
export const FORMULA_VARIABLES: readonly string[] = [...METRIC_IDS, PRICE_VARIABLE, CLICKS_VARIABLE]

export const DEFAULT_SOURCE = 'zeus'
export const DEFAULT_DECIMALS = 2
export const MAX_DECIMALS = 6
export const MAX_COLUMNS = 30
export const MAX_COLUMN_NAME_LENGTH = 64
export const MAX_TEXT_VALUE_LENGTH = 200

const METRICS: ReadonlySet<string> = new Set(METRIC_IDS)
const VARIABLES: ReadonlySet<string> = new Set(FORMULA_VARIABLES)

/** A CSV header and a JSON key alike: printable, one line. */
const PRINTABLE = /^[^\p{Cc}]+$/u

const columnInput = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_COLUMN_NAME_LENGTH)
      .regex(PRINTABLE, 'no control characters or line breaks'),
    formula: z.string().min(1).max(MAX_FORMULA_LENGTH).optional(),
    decimals: z.int().min(0).max(MAX_DECIMALS).optional(),
    value: z
      .string()
      .min(1)
      .max(MAX_TEXT_VALUE_LENGTH)
      .regex(PRINTABLE, 'no control characters or line breaks')
      .optional(),
  })
  .superRefine((column, ctx) => {
    if ((column.formula === undefined) === (column.value === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'give exactly one of "formula" (a calculated number) or "value" (a fixed text)',
      })
    }
    if (column.value !== undefined && column.decimals !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['decimals'],
        message: 'only a formula column is rounded',
      })
    }
  })

export type Column =
  { name: string; formula: string; decimals: number } | { name: string; value: string }

/** The shape of app.webhook.payload_fields. Formulas are checked by compileFields, not here. */
export const payloadFieldsSchema = z
  .strictObject({
    /** external.source id every number of a row comes from; never added across sources. */
    source: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/, 'a source id such as "zeus"')
      .default(DEFAULT_SOURCE),
    columns: z.array(columnInput).min(1).max(MAX_COLUMNS),
  })
  .superRefine((fields, ctx) => {
    // Case-insensitively: a CSV reader matching headers loosely must not see two of one column.
    const seen = new Set(FIXED_COLUMNS.map((name) => name.toLowerCase()))
    fields.columns.forEach((column, index) => {
      const key = column.name.toLowerCase()
      if (FIXED_COLUMNS.some((name) => name.toLowerCase() === key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['columns', index, 'name'],
          message: `"${DATE_COLUMN}" and "${CAMPAIGN_COLUMN}" are always the first two columns; they cannot be entered`,
        })
      } else if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['columns', index, 'name'],
          message: `"${column.name}" is defined twice`,
        })
      }
      seen.add(key)
    })
  })
  // Stored with its defaults filled in, so a later default never changes a webhook already set up.
  .transform((fields) => ({
    source: fields.source,
    columns: fields.columns.map((column): Column =>
      column.formula === undefined
        ? { name: column.name, value: column.value ?? '' }
        : {
            name: column.name,
            formula: column.formula,
            decimals: column.decimals ?? DEFAULT_DECIMALS,
          },
    ),
  }))
export type PayloadFields = z.output<typeof payloadFieldsSchema>
export type PayloadFieldsInput = z.input<typeof payloadFieldsSchema>

export type CompiledColumn =
  | {
      kind: 'formula'
      name: string
      decimals: number
      expr: Expr
      variables: readonly string[]
    }
  | { kind: 'text'; name: string; value: string }

/** A column list, ready to build rows with. */
export interface CompiledFields {
  source: string
  columns: readonly CompiledColumn[]
  /** Every column name in delivery order, the two fixed ones first. */
  names: readonly string[]
  usesPrice: boolean
  usesClicks: boolean
}

/**
 * Parses every formula and checks it only names variables that exist. What a source measures is
 * checked against the database by validateFields; this part needs nothing but the text.
 */
export function compileFields(fields: PayloadFields): CompiledFields {
  const columns = fields.columns.map((column): CompiledColumn => {
    if (!('formula' in column)) return { kind: 'text', name: column.name, value: column.value }
    const describe = (message: string) => `column "${column.name}": ${message}`
    let expr: Expr
    try {
      expr = parseFormula(column.formula)
    } catch (error) {
      if (!(error instanceof InvalidFormulaError)) throw error
      throw new InvalidFormulaError(describe(error.message), { cause: error })
    }
    const variables = variablesOf(expr)
    const unknown = variables.find((name) => !VARIABLES.has(name))
    if (unknown !== undefined) {
      throw new InvalidFormulaError(
        describe(`unknown variable "${unknown}"; use a metric id, "price" or "clicks"`),
      )
    }
    return { kind: 'formula', name: column.name, decimals: column.decimals, expr, variables }
  })

  const reads = (variable: string) =>
    columns.some((column) => column.kind === 'formula' && column.variables.includes(variable))
  return {
    source: fields.source,
    columns,
    names: [...FIXED_COLUMNS, ...columns.map((column) => column.name)],
    usesPrice: reads(PRICE_VARIABLE),
    usesClicks: reads(CLICKS_VARIABLE),
  }
}

/**
 * A column list as stored in app.webhook.payload_fields, ready to use. It was validated when it
 * was saved, so a failure here means the row was edited by hand — or predates version 2.
 */
export function readStoredFields(value: unknown): CompiledFields {
  if (value === null || value === undefined) {
    throw new InvalidWebhookError('payload_fields is empty: a webhook needs a column list')
  }
  const parsed = payloadFieldsSchema.safeParse(value)
  if (!parsed.success) {
    throw new InvalidWebhookError(
      `payload_fields does not match the column list schema: ${z.prettifyError(parsed.error)}`,
    )
  }
  return compileFields(parsed.data)
}

/**
 * Everything compileFields checks, plus what needs the catalog: the source exists, and it measures
 * every metric a formula reads (`clicks` needs cta_counter). Run before a column list is saved.
 */
export async function validateFields(q: Queryable, fields: PayloadFields): Promise<CompiledFields> {
  const compiled = compileFields(fields)

  const rows = await q.query<{ source_id: string; metrics: string[] }>(sql.source_metrics)
  const measured = new Map(rows.map((row) => [row.source_id, new Set(row.metrics)]))
  const metrics = measured.get(compiled.source)
  if (!metrics) {
    throw new InvalidWebhookError(
      `unknown source "${compiled.source}"; one of ${[...measured.keys()].join(', ')}`,
    )
  }

  for (const column of compiled.columns) {
    if (column.kind !== 'formula') continue
    for (const variable of column.variables) {
      const needs = variable === CLICKS_VARIABLE ? 'cta_counter' : variable
      if ((METRICS.has(variable) || variable === CLICKS_VARIABLE) && !metrics.has(needs)) {
        throw new InvalidFormulaError(
          `column "${column.name}": ${compiled.source} does not measure ${variable}, so it can never have a value`,
        )
      }
    }
  }
  return compiled
}

/** The metric ids a column list reads, for the rows query. */
export function metricsRead(fields: CompiledFields): MetricId[] {
  const read = new Set(
    fields.columns.flatMap((column) => (column.kind === 'formula' ? column.variables : [])),
  )
  return METRIC_IDS.filter((id) => read.has(id))
}

/** One campaign a webhook reports on, with what its formulas need. */
export interface ScopeCampaign {
  name: string
  hasPrice: boolean
  /** Whether the campaign has a link to the webhook's source. */
  linked: boolean
}

const NAMES_SHOWN = 10

function nameList(campaigns: readonly ScopeCampaign[]): string {
  const shown = campaigns.slice(0, NAMES_SHOWN).map((campaign) => campaign.name)
  const more = campaigns.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** Pure: what an admin should know before relying on a column list — never a reason to refuse it. */
export function fieldWarnings(fields: CompiledFields, scope: readonly ScopeCampaign[]): string[] {
  const warnings: string[] = []
  const unlinked = scope.filter((campaign) => !campaign.linked)
  if (unlinked.length > 0) {
    warnings.push(
      `these campaigns are not linked to ${fields.source}, so they have no rows until they are: ${nameList(unlinked)}`,
    )
  }
  if (fields.usesPrice) {
    const unpriced = scope.filter((campaign) => campaign.linked && !campaign.hasPrice)
    if (unpriced.length > 0) {
      const names = fields.columns
        .filter((column) => column.kind === 'formula' && column.variables.includes(PRICE_VARIABLE))
        .map((column) => column.name)
      warnings.push(
        `these campaigns have no price, so ${names.join(', ')} will be empty for them until one is set: ${nameList(unpriced)}`,
      )
    }
  }
  return warnings
}

/** The campaigns a webhook reports on today, for fieldWarnings. */
export async function loadScope(
  q: Queryable,
  companyId: string,
  campaignIds: readonly string[] | null,
  source: string,
): Promise<ScopeCampaign[]> {
  const rows = await q.query<{ name: string; has_price: boolean; linked: boolean }>(
    sql.fields_scope,
    [companyId, campaignIds, source],
  )
  return rows.map((row) => ({ name: row.name, hasPrice: row.has_price, linked: row.linked }))
}
