import type { Queryable } from '../../core/db.ts'
import type { DateWindow } from '../../core/dates.ts'
import { loadSql } from '../../core/sql-file.ts'
import { PayloadContractError } from './errors.ts'
import {
  clicksKey,
  dayKey,
  shapePayload,
  type CampaignPrice,
  type CompiledFields,
  type SourceClicks,
} from './fields.ts'
import { parseDecimal, type Fraction } from './formula.ts'
import {
  sourceBlockSchema,
  webhookPayloadSchema,
  type WebhookPayload,
  type WebhookSourceBlock,
} from './payload.ts'

// The one place a webhook body is built: the tick's enqueue, send-now and preview all call
// buildPayload, so a preview shows exactly what a delivery would store and sign. Postgres builds
// the full v1 body (app.build_webhook_payload); a webhook with a field list then gets the few
// extra reads its calculated fields need and is narrowed by fields.ts.

const sql = loadSql(import.meta.url, [
  'build_payload',
  'source_block',
  'campaign_links',
  'campaign_prices',
  'level_clicks',
] as const)

export interface PayloadTarget {
  id: string
  includeCreatives: boolean
}

/** The body for one webhook and period, delivery_id still null (stamped when the row is stored). */
export async function buildPayload(
  q: Queryable,
  webhook: PayloadTarget,
  period: DateWindow,
  fields: CompiledFields | null,
): Promise<unknown> {
  const rows = await q.query<{ payload: unknown }>(sql.build_payload, [
    webhook.id,
    period.from,
    period.to,
  ])
  const full = rows[0]?.payload
  if (fields === null) return full

  const parsed = webhookPayloadSchema.safeParse(full)
  if (!parsed.success) {
    throw new PayloadContractError(
      'app.build_webhook_payload returned a body outside contract v1',
      {
        cause: parsed.error,
      },
    )
  }
  const payload = parsed.data
  await addCalculationSources(q, payload, fields, webhook, period)

  // One after the other: inside a transaction every statement shares one connection anyway.
  const campaignIds = payload.campaigns.map((campaign) => campaign.id)
  const prices = fields.usesPrice
    ? await loadPrices(q, campaignIds)
    : new Map<string, CampaignPrice>()
  const clicks =
    fields.clickSources.length > 0
      ? await loadClicks(q, campaignIds, fields.clickSources, period)
      : new Map<string, SourceClicks>()
  return shapePayload(payload, fields, { prices, clicks })
}

/**
 * A calculated field lives in its source's block, so that block is added wherever the campaign is
 * linked to the source, even when the webhook leaves check sources out. It comes in as a check,
 * in the builder's order: primary first, then by source id.
 */
async function addCalculationSources(
  q: Queryable,
  payload: WebhookPayload,
  fields: CompiledFields,
  webhook: PayloadTarget,
  period: DateWindow,
): Promise<void> {
  const wanted = [...new Set(fields.calculated.map((field) => field.source))]
  const missing = payload.campaigns.flatMap((campaign) =>
    wanted
      .filter((source) => !campaign.sources.some((block) => block.source === source))
      .map((source) => ({ campaign, source })),
  )
  if (missing.length === 0) return

  const links = await q.query<{ campaign_id: string; source_id: string }>(sql.campaign_links, [
    [...new Set(missing.map(({ campaign }) => campaign.id))],
    wanted,
  ])
  const linked = new Set(links.map((link) => clicksKey(link.campaign_id, link.source_id)))

  for (const { campaign, source } of missing) {
    if (!linked.has(clicksKey(campaign.id, source))) continue
    const [row] = await q.query<{ block: unknown }>(sql.source_block, [
      campaign.id,
      source,
      period.from,
      period.to,
      webhook.includeCreatives,
    ])
    const block = sourceBlockSchema.safeParse(row?.block)
    if (!block.success) {
      throw new PayloadContractError(
        'app.webhook_source_block returned a block outside contract v1',
        { cause: block.error },
      )
    }
    campaign.sources.push(block.data)
    campaign.sources.sort(builderOrder)
  }
}

function builderOrder(a: WebhookSourceBlock, b: WebhookSourceBlock): number {
  if (a.role !== b.role) return a.role === 'primary' ? -1 : 1
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0
}

async function loadPrices(
  q: Queryable,
  campaignIds: readonly string[],
): Promise<Map<string, CampaignPrice>> {
  const rows = await q.query<{ id: string; price: string | null; currency: string | null }>(
    sql.campaign_prices,
    [campaignIds],
  )
  return new Map(rows.map((row) => [row.id, { value: row.price, currency: row.currency }]))
}

interface ClicksRow {
  campaign_id: string
  source: string
  level: 'daily' | 'creative' | 'total'
  events_date: string | null
  language: string | null
  campaign_tag: string | null
  clicks: string
}

async function loadClicks(
  q: Queryable,
  campaignIds: readonly string[],
  sources: readonly string[],
  period: DateWindow,
): Promise<Map<string, SourceClicks>> {
  const rows = await q.query<ClicksRow>(sql.level_clicks, [
    campaignIds,
    sources,
    period.from,
    period.to,
  ])
  const out = new Map<
    string,
    { total: Fraction | null; daily: Map<string, Fraction>; creatives: Map<string, Fraction> }
  >()
  for (const row of rows) {
    const key = clicksKey(row.campaign_id, row.source)
    let entry = out.get(key)
    if (!entry) {
      entry = { total: null, daily: new Map(), creatives: new Map() }
      out.set(key, entry)
    }
    const clicks = parseDecimal(row.clicks)
    if (row.level === 'total') entry.total = clicks
    else if (row.level === 'daily') {
      entry.daily.set(dayKey(row.events_date ?? '', row.language ?? ''), clicks)
    } else entry.creatives.set(row.campaign_tag ?? '', clicks)
  }
  return out
}
