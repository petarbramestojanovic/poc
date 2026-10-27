import { z } from 'zod'
import type { Queryable } from '../../core/db.ts'
import { loadSql } from '../../core/sql-file.ts'
import { METRIC_IDS, type MetricId } from '../sync/types.ts'
import { InvalidFormulaError, InvalidWebhookError } from './errors.ts'
import { MAX_FORMULA_LENGTH, parseFormula, variablesOf, type Expr } from './formula.ts'

// What one webhook delivers (app.webhook.payload_fields). A Brame admin agrees it with the client
// and enters it; the client never sees this config, only the rows it produces.
//
// A report is a table with the client's columns, filled by ROW SETS. Each row set reads one
// source at one level — `campaign` (one row per campaign and day, its creatives and languages
// merged) or `creative` (one row per creative and day, languages merged) — and says what goes in
// each column for its rows: a formula, a fixed text, or a row variable. A column a row set does
// not bind is empty on its rows. Two row sets are two series printed in one table; nothing is ever
// added across them (rule 5: never sum across sources).
//
//   { "columns": ["Ad Type", "Impressions", "Clicks", "Cost"],
//     "rows": [
//       { "source": "zeus", "level": "campaign",
//         "values": { "Ad Type":     { "value": "Dynamic Ad" },
//                     "Impressions": { "formula": "impressions", "decimals": 0 },
//                     "Clicks":      { "formula": "clicks", "decimals": 0 },
//                     "Cost":        { "formula": "impressions / 1000 * price" } } },
//       { "source": "nexd", "level": "creative",
//         "values": { "Ad Type":     { "value": "Dynamic Ad" },
//                     "Impressions": { "formula": "impressions", "decimals": 0 },
//                     "Cost":        { "formula": "impressions / 1000 * price" } } } ] }
//
// Every row starts with `Date` and `Campaign` (the campaign's name). When a creative-level row set
// keeps the campaign there, a third fixed column `Creative` carries the creative's label (empty on
// campaign-level rows); a row set may instead put the label in the `Campaign` cell
// (`"name": "creative"`). The one-source form `{ "source", "columns": [{ name, formula | value }] }`
// is still accepted and means one campaign-level row set.
//
// A formula (formula.ts) reads that row's own numbers: a stored metric, `clicks` (non-internal CTA
// clicks) or `price` (the campaign's CPM). It is computed for each row from that row, never by
// adding up other results. A variable without a value, or a division by zero, makes it null —
// never 0.

const sql = loadSql(import.meta.url, ['source_metrics', 'fields_scope'] as const)

/** The two columns every row starts with, in this order. */
export const DATE_COLUMN = 'Date'
export const CAMPAIGN_COLUMN = 'Campaign'
/** The third fixed column, present when a creative-level row set keeps the campaign in `Campaign`. */
export const CREATIVE_COLUMN = 'Creative'
export const FIXED_COLUMNS: readonly string[] = [DATE_COLUMN, CAMPAIGN_COLUMN]
/** Names the admin cannot use: the fixed columns, whichever of them a report has. */
export const RESERVED_COLUMNS: readonly string[] = [DATE_COLUMN, CAMPAIGN_COLUMN, CREATIVE_COLUMN]

/** The campaign's CPM (app.campaign.price, migration 0005), in the campaign's currency. */
export const PRICE_VARIABLE = 'price'
/** Non-internal CTA clicks of the row (analytics.cta_clicks), in the row set's source. */
export const CLICKS_VARIABLE = 'clicks'

/** Every name a formula may use. */
export const FORMULA_VARIABLES: readonly string[] = [...METRIC_IDS, PRICE_VARIABLE, CLICKS_VARIABLE]

/** What a row set groups by. */
export const LEVELS = ['campaign', 'creative'] as const
export type Level = (typeof LEVELS)[number]
/** What the `Campaign` cell of a row shows. */
export const NAMES = ['campaign', 'creative'] as const
export type Name = (typeof NAMES)[number]
/** What a text column may print about the row itself, for a client filtering row kinds. */
export const ROW_VARIABLES = ['source', 'level'] as const
export type RowVariable = (typeof ROW_VARIABLES)[number]

export const DEFAULT_SOURCE = 'zeus'
export const DEFAULT_DECIMALS = 2
export const MAX_DECIMALS = 6
export const MAX_COLUMNS = 30
export const MAX_ROW_SETS = 6
export const MAX_COLUMN_NAME_LENGTH = 64
export const MAX_TEXT_VALUE_LENGTH = 200

const METRICS: ReadonlySet<string> = new Set(METRIC_IDS)
const VARIABLES: ReadonlySet<string> = new Set(FORMULA_VARIABLES)
const RESERVED: ReadonlySet<string> = new Set(RESERVED_COLUMNS.map((name) => name.toLowerCase()))

/** A CSV header and a JSON key alike: printable, one line. */
const PRINTABLE = /^[^\p{Cc}]+$/u

const columnName = z
  .string()
  .trim()
  .min(1)
  .max(MAX_COLUMN_NAME_LENGTH)
  .regex(PRINTABLE, 'no control characters or line breaks')
const formula = z.string().min(1).max(MAX_FORMULA_LENGTH)
const decimals = z.int().min(0).max(MAX_DECIMALS)
const text = z
  .string()
  .min(1)
  .max(MAX_TEXT_VALUE_LENGTH)
  .regex(PRINTABLE, 'no control characters or line breaks')
const sourceId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'a source id such as "zeus"')

/** One cell of a row set: exactly one of a formula, a fixed text or a row variable. */
const cellInput = z
  .strictObject({
    formula: formula.optional(),
    decimals: decimals.optional(),
    value: text.optional(),
    variable: z.enum(ROW_VARIABLES).optional(),
  })
  .superRefine((cell, ctx) => {
    const given = [cell.formula, cell.value, cell.variable].filter((v) => v !== undefined).length
    if (given !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message:
          'give exactly one of "formula" (a calculated number), "value" (a fixed text) or "variable" (source or level)',
      })
    }
    if (cell.formula === undefined && cell.decimals !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['decimals'], message: 'only a formula is rounded' })
    }
  })

export type Cell =
  { formula: string; decimals: number } | { value: string } | { variable: RowVariable }

const normaliseCell = (cell: z.output<typeof cellInput>): Cell =>
  cell.formula !== undefined
    ? { formula: cell.formula, decimals: cell.decimals ?? DEFAULT_DECIMALS }
    : cell.variable !== undefined
      ? { variable: cell.variable }
      : { value: cell.value ?? '' }

const rowSetInput = z
  .strictObject({
    /** external.source id every number of these rows comes from; never added across sources. */
    source: sourceId.default(DEFAULT_SOURCE),
    level: z.enum(LEVELS).default('campaign'),
    /** `creative`: the label goes in the Campaign cell instead of its own Creative column. */
    name: z.enum(NAMES).default('campaign'),
    /** By column name; a column left out is empty on these rows. */
    values: z.record(z.string(), cellInput),
  })
  .superRefine((set, ctx) => {
    if (set.name === 'creative' && set.level !== 'creative') {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: '"creative" names a row after its creative, so it needs "level": "creative"',
      })
    }
  })

export interface RowSet {
  source: string
  level: Level
  name: Name
  values: Record<string, Cell>
}

/** The stored shape: the client's columns, and the row sets that fill them. */
export interface PayloadFields {
  columns: string[]
  rows: RowSet[]
}

const checkColumnNames = (columns: readonly string[], ctx: z.RefinementCtx, path: string) => {
  // Case-insensitively: a CSV reader matching headers loosely must not see two of one column.
  const seen = new Set<string>()
  columns.forEach((name, index) => {
    const key = name.toLowerCase()
    if (RESERVED.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [path, index, ...(path === 'columns' ? [] : ['name'])],
        message: `${RESERVED_COLUMNS.map((c) => `"${c}"`).join(', ')} are the fixed first columns; they cannot be entered`,
      })
    } else if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [path, index, ...(path === 'columns' ? [] : ['name'])],
        message: `"${name}" is defined twice`,
      })
    }
    seen.add(key)
  })
}

const rowSetsInput = z
  .strictObject({
    columns: z.array(columnName).min(1).max(MAX_COLUMNS),
    rows: z.array(rowSetInput).min(1).max(MAX_ROW_SETS),
  })
  .superRefine((fields, ctx) => {
    checkColumnNames(fields.columns, ctx, 'columns')
    const known = new Set(fields.columns)
    fields.rows.forEach((set, index) => {
      for (const name of Object.keys(set.values)) {
        if (!known.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['rows', index, 'values', name],
            message: `"${name}" is not one of the columns`,
          })
        }
      }
    })
  })
  .transform((fields): PayloadFields => ({
    columns: fields.columns,
    rows: fields.rows.map((set) => ({
      source: set.source,
      level: set.level,
      name: set.name,
      // In column order, so the stored object reads like the table it makes.
      values: Object.fromEntries(
        fields.columns.flatMap((name) => {
          const cell = set.values[name]
          return cell === undefined ? [] : [[name, normaliseCell(cell)] as const]
        }),
      ),
    })),
  }))

/** The one-source form: a column list, each column with its own formula or text. */
const legacyColumnInput = z
  .strictObject({
    name: columnName,
    formula: formula.optional(),
    decimals: decimals.optional(),
    value: text.optional(),
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

const legacyInput = z
  .strictObject({
    source: sourceId.default(DEFAULT_SOURCE),
    columns: z.array(legacyColumnInput).min(1).max(MAX_COLUMNS),
  })
  .superRefine((fields, ctx) => {
    checkColumnNames(
      fields.columns.map((column) => column.name),
      ctx,
      'columns',
    )
  })
  .transform((fields): PayloadFields => ({
    columns: fields.columns.map((column) => column.name),
    rows: [
      {
        source: fields.source,
        level: 'campaign',
        name: 'campaign',
        values: Object.fromEntries(
          fields.columns.map((column) => [
            column.name,
            normaliseCell({
              ...(column.formula === undefined ? {} : { formula: column.formula }),
              ...(column.decimals === undefined ? {} : { decimals: column.decimals }),
              ...(column.value === undefined ? {} : { value: column.value }),
            }),
          ]),
        ),
      },
    ],
  }))

export type PayloadFieldsInput = z.input<typeof rowSetsInput> | z.input<typeof legacyInput>

/**
 * The shape of app.webhook.payload_fields: the row-set form, or the one-source form, which
 * becomes one campaign-level row set. Stored with its defaults filled in, so a later default never
 * changes a webhook already set up. Formulas are checked by compileFields, not here.
 */
export const payloadFieldsSchema = z.custom<PayloadFieldsInput>().transform((value, ctx) => {
  // z.custom lets anything in: a stored row edited by hand may be no object at all.
  const input: unknown = value
  const form =
    input !== null && typeof input === 'object' && 'rows' in input ? rowSetsInput : legacyInput
  const parsed = form.safeParse(input)
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
  return z.NEVER
})

export type CompiledCell =
  | { kind: 'formula'; decimals: number; expr: Expr; variables: readonly string[] }
  | { kind: 'text'; value: string }
  | { kind: 'variable'; variable: RowVariable }
  | { kind: 'empty' }

export interface CompiledRowSet {
  source: string
  level: Level
  name: Name
  /** One per admin column, in column order. */
  cells: readonly CompiledCell[]
  /** Every variable its formulas read. */
  variables: readonly string[]
  usesPrice: boolean
  usesClicks: boolean
}

/** A column list, ready to build rows with. */
export interface CompiledFields {
  /** The admin's columns, in delivery order. */
  columns: readonly string[]
  /** Every column name in delivery order: the fixed ones, then `columns`. */
  names: readonly string[]
  /** Whether `Creative` is a fixed column of this report. */
  creativeColumn: boolean
  rowSets: readonly CompiledRowSet[]
  /** Distinct sources in row-set order. */
  sources: readonly string[]
  /** The source a scheduled report waits for: the first row set's. */
  waitSource: string
}

/**
 * Parses every formula and checks it only names variables that exist. What a source measures is
 * checked against the database by validateFields; this part needs nothing but the text.
 */
export function compileFields(fields: PayloadFields): CompiledFields {
  const rowSets = fields.rows.map((set): CompiledRowSet => {
    const cells = fields.columns.map((name): CompiledCell => {
      const cell = set.values[name]
      if (cell === undefined) return { kind: 'empty' }
      if ('value' in cell) return { kind: 'text', value: cell.value }
      if ('variable' in cell) return { kind: 'variable', variable: cell.variable }
      const describe = (message: string) => `column "${name}": ${message}`
      let expr: Expr
      try {
        expr = parseFormula(cell.formula)
      } catch (error) {
        if (!(error instanceof InvalidFormulaError)) throw error
        throw new InvalidFormulaError(describe(error.message), { cause: error })
      }
      const variables = variablesOf(expr)
      const unknown = variables.find((variable) => !VARIABLES.has(variable))
      if (unknown !== undefined) {
        throw new InvalidFormulaError(
          describe(`unknown variable "${unknown}"; use a metric id, "price" or "clicks"`),
        )
      }
      return { kind: 'formula', decimals: cell.decimals, expr, variables }
    })
    const variables = [
      ...new Set(cells.flatMap((cell) => (cell.kind === 'formula' ? cell.variables : []))),
    ]
    return {
      source: set.source,
      level: set.level,
      name: set.name,
      cells,
      variables,
      usesPrice: variables.includes(PRICE_VARIABLE),
      usesClicks: variables.includes(CLICKS_VARIABLE),
    }
  })

  const creativeColumn = rowSets.some((set) => set.level === 'creative' && set.name === 'campaign')
  const sources = [...new Set(rowSets.map((set) => set.source))]
  const [waitSource] = sources
  if (waitSource === undefined) throw new InvalidWebhookError('a column list needs a row set')
  return {
    columns: fields.columns,
    names: [...FIXED_COLUMNS, ...(creativeColumn ? [CREATIVE_COLUMN] : []), ...fields.columns],
    creativeColumn,
    rowSets,
    sources,
    waitSource,
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
 * Everything compileFields checks, plus what needs the catalog: every row set's source exists, and
 * it measures every metric a formula of that row set reads (`clicks` needs cta_counter). Run
 * before a column list is saved.
 */
export async function validateFields(q: Queryable, fields: PayloadFields): Promise<CompiledFields> {
  const compiled = compileFields(fields)

  const rows = await q.query<{ source_id: string; metrics: string[] }>(sql.source_metrics)
  const measured = new Map(rows.map((row) => [row.source_id, new Set(row.metrics)]))

  for (const set of compiled.rowSets) {
    const metrics = measured.get(set.source)
    if (!metrics) {
      throw new InvalidWebhookError(
        `unknown source "${set.source}"; one of ${[...measured.keys()].join(', ')}`,
      )
    }
    set.cells.forEach((cell, index) => {
      if (cell.kind !== 'formula') return
      for (const variable of cell.variables) {
        const needs = variable === CLICKS_VARIABLE ? 'cta_counter' : variable
        if ((METRICS.has(variable) || variable === CLICKS_VARIABLE) && !metrics.has(needs)) {
          throw new InvalidFormulaError(
            `column "${compiled.columns[index] ?? ''}": ${set.source} does not measure ${variable}, so it can never have a value`,
          )
        }
      }
    })
  }
  return compiled
}

/** The metric ids a column list reads, across its row sets, for the rows query. */
export function metricsRead(fields: CompiledFields | CompiledRowSet): MetricId[] {
  const sets = 'rowSets' in fields ? fields.rowSets : [fields]
  const read = new Set(sets.flatMap((set) => set.variables))
  return METRIC_IDS.filter((id) => read.has(id))
}

/** One campaign a webhook reports on, with what its formulas need. */
export interface ScopeCampaign {
  name: string
  hasPrice: boolean
  /** Whether the campaign has a link to the source asked about. */
  linked: boolean
}

const NAMES_SHOWN = 10

function nameList(campaigns: readonly ScopeCampaign[]): string {
  const shown = campaigns.slice(0, NAMES_SHOWN).map((campaign) => campaign.name)
  const more = campaigns.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/**
 * Pure: what an admin should know before relying on a column list — never a reason to refuse it.
 * `scopes` holds the webhook's campaigns as seen from each source the list reads.
 */
export function fieldWarnings(
  fields: CompiledFields,
  scopes: ReadonlyMap<string, readonly ScopeCampaign[]>,
): string[] {
  const warnings: string[] = []
  for (const source of fields.sources) {
    const scope = scopes.get(source) ?? []
    const unlinked = scope.filter((campaign) => !campaign.linked)
    if (unlinked.length > 0) {
      warnings.push(
        `these campaigns are not linked to ${source}, so they have no rows until they are: ${nameList(unlinked)}`,
      )
    }
    const priced = fields.rowSets.filter((set) => set.source === source && set.usesPrice)
    if (priced.length === 0) continue
    const unpriced = scope.filter((campaign) => campaign.linked && !campaign.hasPrice)
    if (unpriced.length > 0) {
      const names = [
        ...new Set(
          priced.flatMap((set) =>
            set.cells.flatMap((cell, index) =>
              cell.kind === 'formula' && cell.variables.includes(PRICE_VARIABLE)
                ? [fields.columns[index] ?? '']
                : [],
            ),
          ),
        ),
      ]
      warnings.push(
        `these campaigns have no price, so ${names.join(', ')} will be empty for them until one is set: ${nameList(unpriced)}`,
      )
    }
  }
  return warnings
}

/** The campaigns a webhook reports on today, as seen from one source, for fieldWarnings. */
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

/** The campaigns of a webhook as seen from every source its column list reads. */
export async function loadScopes(
  q: Queryable,
  fields: CompiledFields,
  companyId: string,
  campaignIds: readonly string[] | null,
): Promise<Map<string, ScopeCampaign[]>> {
  const scopes = new Map<string, ScopeCampaign[]>()
  // One after the other: a transaction has one connection.
  for (const source of fields.sources) {
    scopes.set(source, await loadScope(q, companyId, campaignIds, source))
  }
  return scopes
}
