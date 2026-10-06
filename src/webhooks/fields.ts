import { z } from 'zod'
import type { Queryable } from '../db.ts'
import { loadSql } from '../sql-file.ts'
import { METRIC_IDS, type MetricId } from '../sync/types.ts'
import { InvalidFormulaError, InvalidWebhookError } from './errors.ts'
import {
  evaluate,
  fromNumber,
  MAX_FORMULA_LENGTH,
  parseDecimal,
  parseFormula,
  toRoundedNumber,
  variablesOf,
  type Expr,
  type Fraction,
} from './formula.ts'
import {
  PAYLOAD_SECTIONS,
  type PayloadSection,
  type PayloadShape,
  type WebhookCampaign,
  type WebhookMetrics,
  type WebhookPayload,
  type WebhookSourceBlock,
} from './payload.ts'

// What one webhook delivers (app.webhook.payload_fields, migration 0007). A Brame admin agrees it
// with the client and enters it; the client never sees this config, only the body it produces.
//
//   metrics     which stored metrics appear in every metrics object; absent = every measured one
//   sections    which lists a source block carries (daily, ctas, pages); absent = all of them
//   calculated  fields computed by a formula (formula.ts) from ONE source's numbers, e.g.
//               { name: 'cost', formula: 'impressions / 1000 * price', source: 'zeus', decimals: 2 }
//
// A calculated field is computed at every level of its source's block from that level's own
// numbers — the period totals, each daily entry, each creative — and never by adding up another
// level's results: a week's cost is the week's impressions / 1000 × price, not the sum of rounded
// daily costs. A variable without a value, or a division by zero, makes it null, never 0. It
// appears only in its source's block, so a campaign never shows two costs.
//
// Without a field list (NULL) the body is the full v1 body, untouched.

const sql = loadSql(import.meta.url, ['source_metrics', 'fields_scope'] as const)

/** The campaign's CPM (app.campaign.price, migration 0005), in the campaign's currency. */
export const PRICE_VARIABLE = 'price'
/** Non-internal CTA clicks of the level (analytics.cta_clicks), in the formula's source. */
export const CLICKS_VARIABLE = 'clicks'

/** Every name a formula may use. */
export const FORMULA_VARIABLES: readonly string[] = [...METRIC_IDS, PRICE_VARIABLE, CLICKS_VARIABLE]

export const DEFAULT_CALCULATION_SOURCE = 'zeus'
export const DEFAULT_DECIMALS = 2
export const MAX_DECIMALS = 6
export const MAX_CALCULATED_FIELDS = 20

const METRICS: ReadonlySet<string> = new Set(METRIC_IDS)
const VARIABLES: ReadonlySet<string> = new Set(FORMULA_VARIABLES)

/**
 * Names a calculated field cannot take: every key a metrics object, a daily entry or a creative
 * already uses, the catalog ids that appear in metrics_available, and the formula variables.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...FORMULA_VARIABLES,
  'cta_counter',
  'view_counter',
  'currency',
  'date',
  'language',
  'campaign_tag',
  'label',
])

export const calculatedFieldSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/, 'lowercase letters, digits and _, starting with a letter'),
  formula: z.string().min(1).max(MAX_FORMULA_LENGTH),
  /** external.source id whose block the field is computed in and appears in. */
  source: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/, 'a source id such as "zeus"')
    .default(DEFAULT_CALCULATION_SOURCE),
  decimals: z.int().min(0).max(MAX_DECIMALS).default(DEFAULT_DECIMALS),
})
export type CalculatedField = z.output<typeof calculatedFieldSchema>

/** The shape of app.webhook.payload_fields. Formulas are checked by compileFields, not here. */
export const payloadFieldsSchema = z
  .strictObject({
    metrics: z.array(z.enum(METRIC_IDS)).optional(),
    sections: z.array(z.enum(PAYLOAD_SECTIONS)).optional(),
    calculated: z.array(calculatedFieldSchema).max(MAX_CALCULATED_FIELDS).default([]),
  })
  .superRefine((fields, ctx) => {
    const repeated = (values: readonly string[]) =>
      values.find((value, index) => values.indexOf(value) !== index)
    const metric = repeated(fields.metrics ?? [])
    if (metric !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['metrics'], message: `"${metric}" is listed twice` })
    }
    const section = repeated(fields.sections ?? [])
    if (section !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['sections'], message: `"${section}" is listed twice` })
    }
    const names = fields.calculated.map((field) => field.name)
    names.forEach((name, index) => {
      if (RESERVED_NAMES.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calculated', index, 'name'],
          message: `"${name}" is already a key of the payload or a formula variable`,
        })
      } else if (names.indexOf(name) !== index) {
        ctx.addIssue({
          code: 'custom',
          path: ['calculated', index, 'name'],
          message: `"${name}" is defined twice`,
        })
      }
    })
  })
export type PayloadFields = z.output<typeof payloadFieldsSchema>
export type PayloadFieldsInput = z.input<typeof payloadFieldsSchema>

export interface CompiledField {
  name: string
  source: string
  decimals: number
  expr: Expr
  variables: readonly string[]
}

/** A field list, ready to shape bodies with. */
export interface CompiledFields {
  /** null = every measured metric. */
  metrics: ReadonlySet<MetricId> | null
  sections: ReadonlySet<PayloadSection>
  calculated: readonly CompiledField[]
  usesPrice: boolean
  /** The sources whose formulas read `clicks`: only those need click counts per level. */
  clickSources: readonly string[]
}

/**
 * Parses every formula and checks it only names variables that exist. What a source measures is
 * checked against the database by validateFields; this part needs nothing but the text.
 */
export function compileFields(fields: PayloadFields): CompiledFields {
  const calculated = fields.calculated.map((field): CompiledField => {
    const describe = (message: string) => `calculated field "${field.name}": ${message}`
    let expr: Expr
    try {
      expr = parseFormula(field.formula)
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
    return {
      name: field.name,
      source: field.source,
      decimals: field.decimals,
      expr,
      variables,
    }
  })

  return {
    metrics: fields.metrics ? new Set(fields.metrics) : null,
    sections: new Set(fields.sections ?? PAYLOAD_SECTIONS),
    calculated,
    usesPrice: calculated.some((field) => field.variables.includes(PRICE_VARIABLE)),
    clickSources: [
      ...new Set(
        calculated
          .filter((field) => field.variables.includes(CLICKS_VARIABLE))
          .map((field) => field.source),
      ),
    ],
  }
}

/**
 * A field list as stored in app.webhook.payload_fields, ready to use; null when there is none.
 * It was validated when it was saved, so a failure here means the row was edited by hand.
 */
export function readStoredFields(value: unknown): CompiledFields | null {
  if (value === null || value === undefined) return null
  const parsed = payloadFieldsSchema.safeParse(value)
  if (!parsed.success) {
    throw new InvalidWebhookError(
      `payload_fields does not match the field list schema: ${z.prettifyError(parsed.error)}`,
    )
  }
  return compileFields(parsed.data)
}

/**
 * Everything compileFields checks, plus what needs the catalog: the source exists, and it measures
 * every metric its formula reads (`clicks` needs cta_counter). Run before a field list is saved.
 */
export async function validateFields(q: Queryable, fields: PayloadFields): Promise<CompiledFields> {
  const compiled = compileFields(fields)
  if (compiled.calculated.length === 0) return compiled

  const rows = await q.query<{ source_id: string; metrics: string[] }>(sql.source_metrics)
  const measured = new Map(rows.map((row) => [row.source_id, new Set(row.metrics)]))

  for (const field of compiled.calculated) {
    const describe = (message: string) => `calculated field "${field.name}": ${message}`
    const metrics = measured.get(field.source)
    if (!metrics) {
      throw new InvalidFormulaError(
        describe(`unknown source "${field.source}"; one of ${[...measured.keys()].join(', ')}`),
      )
    }
    for (const variable of field.variables) {
      const needs = variable === CLICKS_VARIABLE ? 'cta_counter' : variable
      if ((METRICS.has(variable) || variable === CLICKS_VARIABLE) && !metrics.has(needs)) {
        throw new InvalidFormulaError(
          describe(`${field.source} does not measure ${variable}, so it can never have a value`),
        )
      }
    }
  }
  return compiled
}

/** One campaign a webhook reports on, with what its calculated fields need. */
export interface ScopeCampaign {
  name: string
  hasPrice: boolean
  /** Sources the campaign has a link to. */
  sources: readonly string[]
}

const NAMES_SHOWN = 10

function nameList(campaigns: readonly ScopeCampaign[]): string {
  const shown = campaigns.slice(0, NAMES_SHOWN).map((campaign) => campaign.name)
  const more = campaigns.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** Pure: what an admin should know before relying on a field list — never a reason to refuse it. */
export function fieldWarnings(fields: CompiledFields, scope: readonly ScopeCampaign[]): string[] {
  const warnings: string[] = []
  if (fields.usesPrice) {
    const unpriced = scope.filter((campaign) => !campaign.hasPrice)
    if (unpriced.length > 0) {
      const names = fields.calculated
        .filter((field) => field.variables.includes(PRICE_VARIABLE))
        .map((field) => field.name)
      warnings.push(
        `these campaigns have no price, so ${names.join(', ')} will be null for them until one is set: ${nameList(unpriced)}`,
      )
    }
  }
  for (const source of new Set(fields.calculated.map((field) => field.source))) {
    const unlinked = scope.filter((campaign) => !campaign.sources.includes(source))
    if (unlinked.length > 0) {
      const names = fields.calculated
        .filter((field) => field.source === source)
        .map((field) => field.name)
      warnings.push(
        `these campaigns are not linked to ${source}, so ${names.join(', ')} will carry no value for them: ${nameList(unlinked)}`,
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
): Promise<ScopeCampaign[]> {
  const rows = await q.query<{ name: string; has_price: boolean; sources: string[] }>(
    sql.fields_scope,
    [companyId, campaignIds],
  )
  return rows.map((row) => ({ name: row.name, hasPrice: row.has_price, sources: row.sources }))
}

/** What the contract expects of the body this field list produces (payload.ts). */
export function payloadShapeOf(fields: CompiledFields): PayloadShape {
  return {
    sections: PAYLOAD_SECTIONS.filter((section) => fields.sections.has(section)),
    calculated: fields.calculated.map((field) => field.name),
    price: fields.usesPrice,
  }
}

// ---------------------------------------------------------------------------------------------
// Shaping a body
// ---------------------------------------------------------------------------------------------

/** app.campaign.price as exact text, and its currency; both null when the price is not known. */
export interface CampaignPrice {
  value: string | null
  currency: string | null
}

/** Clicks of one campaign in one source, per level. A level without click rows is absent. */
export interface SourceClicks {
  total: Fraction | null
  /** Keyed by dayKey(date, language). */
  daily: ReadonlyMap<string, Fraction>
  /** Keyed by campaign_tag. */
  creatives: ReadonlyMap<string, Fraction>
}

export interface ShapeInputs {
  /** By campaign id; needed when a formula uses the price. */
  prices: ReadonlyMap<string, CampaignPrice>
  /** By clicksKey(campaign id, source); needed when a formula uses clicks. */
  clicks: ReadonlyMap<string, SourceClicks>
}

export const dayKey = (date: string, language: string): string => JSON.stringify([date, language])
export const clicksKey = (campaignId: string, source: string): string =>
  JSON.stringify([campaignId, source])

type Shaped = Record<string, unknown>

/**
 * Pure: the body a webhook with this field list sends, from the full v1 body. It must already
 * hold a block for every source a calculated field names wherever the campaign has one
 * (build.ts adds those the webhook's own check-source switch left out).
 */
export function shapePayload(
  payload: WebhookPayload,
  fields: CompiledFields,
  inputs: ShapeInputs,
): Shaped {
  return {
    ...payload,
    campaigns: payload.campaigns.map((campaign) => shapeCampaign(campaign, fields, inputs)),
  }
}

function shapeCampaign(
  campaign: WebhookCampaign,
  fields: CompiledFields,
  inputs: ShapeInputs,
): Shaped {
  const price = inputs.prices.get(campaign.id) ?? { value: null, currency: null }
  const priceValue = price.value === null ? null : parseDecimal(price.value)
  return {
    id: campaign.id,
    name: campaign.name,
    primary_source: campaign.primary_source,
    ...(fields.usesPrice
      ? {
          price: price.value === null ? null : Number(price.value),
          currency: price.value === null ? null : price.currency,
        }
      : {}),
    sources: campaign.sources.map((block) =>
      shapeBlock(
        block,
        fields,
        priceValue,
        inputs.clicks.get(clicksKey(campaign.id, block.source)),
      ),
    ),
  }
}

function shapeBlock(
  block: WebhookSourceBlock,
  fields: CompiledFields,
  price: Fraction | null,
  clicks: SourceClicks | undefined,
): Shaped {
  const formulas = fields.calculated.filter((field) => field.source === block.source)
  const metricsOf = (values: WebhookMetrics, levelClicks: Fraction | null) =>
    shapeMetrics(values, fields.metrics, calculate(formulas, values, price, levelClicks))

  const shaped: Shaped = {
    source: block.source,
    display_name: block.display_name,
    role: block.role,
    day_timezone: block.day_timezone,
    data_complete_through: block.data_complete_through,
    last_synced_at: block.last_synced_at,
    metrics_available: [
      ...block.metrics_available.filter((id) => stillAvailable(id, fields)),
      ...formulas.map((field) => field.name),
    ],
    totals: metricsOf(block.totals, clicks?.total ?? null),
    creatives: block.creatives.map((creative) => ({
      campaign_tag: creative.campaign_tag,
      label: creative.label,
      totals: metricsOf(creative.totals, clicks?.creatives.get(creative.campaign_tag) ?? null),
    })),
  }
  if (fields.sections.has('daily')) {
    shaped.daily = block.daily.map((entry) => ({
      date: entry.date,
      language: entry.language,
      ...metricsOf(entry, clicks?.daily.get(dayKey(entry.date, entry.language)) ?? null),
    }))
  }
  if (fields.sections.has('ctas')) shaped.ctas = block.ctas
  if (fields.sections.has('pages')) shaped.pages = block.pages
  return shaped
}

/** A metrics_available entry survives when its metric, or the list it describes, is delivered. */
function stillAvailable(id: string, fields: CompiledFields): boolean {
  if (METRICS.has(id)) return fields.metrics === null || fields.metrics.has(id as MetricId)
  if (id === 'cta_counter') return fields.sections.has('ctas')
  if (id === 'view_counter') return fields.sections.has('pages')
  return true
}

/** The delivered metrics of one level, measured ones first, then the calculated ones. */
function shapeMetrics(
  values: WebhookMetrics,
  keep: ReadonlySet<MetricId> | null,
  calculated: Record<string, number | null>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const id of METRIC_IDS) {
    // Absent stays absent: the source does not measure it.
    if (Object.hasOwn(values, id) && (keep === null || keep.has(id))) out[id] = values[id] ?? null
  }
  return { ...out, ...calculated }
}

/** Every formula of the block at one level, from that level's own numbers. */
function calculate(
  formulas: readonly CompiledField[],
  values: WebhookMetrics,
  price: Fraction | null,
  clicks: Fraction | null,
): Record<string, number | null> {
  const lookup = (name: string): Fraction | null => {
    if (name === PRICE_VARIABLE) return price
    if (name === CLICKS_VARIABLE) return clicks
    if (!METRICS.has(name) || !Object.hasOwn(values, name)) return null
    const value = values[name as MetricId]
    return typeof value === 'number' ? fromNumber(value) : null
  }
  const out: Record<string, number | null> = {}
  for (const field of formulas) {
    const value = evaluate(field.expr, lookup)
    out[field.name] = value === null ? null : toRoundedNumber(value, field.decimals)
  }
  return out
}
