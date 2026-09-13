import type { IsoDate } from '../../../dates.ts'
import { VerificationError } from '../../errors.ts'
import { mergeRows } from '../../merge.ts'
import type { CanonicalDailyRow, LinkEntity } from '../../types.ts'
import type { ZeusCampaignsRow, ZeusCreativesRow, ZeusTrackerRow } from './schema.ts'

// Pure. Delivery rows (creatives or campaigns) and pixel fires become one row per
// (entity, date), merged per (date, campaign_tag) by the shared aggregation rules: counts add,
// the per-day unique_* scalars are never added across entities. A pixel's fires land on the
// tag its link_entity carries, which an operator sets to its creative's tag. Metrics Zeus does
// not measure are absent, never zero.

export interface Matched<T> {
  entity: LinkEntity
  row: T
}

export interface ZeusMapperInput {
  language: string
  clickthroughCtaId: string
  creatives: Matched<ZeusCreativesRow>[]
  campaigns: Matched<ZeusCampaignsRow>[]
  tracker: Matched<ZeusTrackerRow>[]
  /** Tracker rows for pixels no link_entity claims, already labelled. */
  unmatchedPixels: { label: string; date: IsoDate; fires: number }[]
}

export class ZeusInvariantError extends VerificationError {
  override readonly name = 'ZeusInvariantError'
}

type DeliveryRow = Pick<
  ZeusCampaignsRow,
  'date' | 'impressions' | 'clicks' | 'visible_impressions' | 'unique_impressions' | 'unique_clicks'
>

function checkDelivery(
  kind: string,
  entity: LinkEntity,
  row: DeliveryRow,
  subject: string,
  warn: (message: string) => void,
): void {
  const counts: [string, number | undefined][] = [
    ['clicks', row.clicks],
    ['visible_impressions', row.visible_impressions],
    ['unique_impressions', row.unique_impressions],
  ]
  const violated = counts.find(([, value]) => value !== undefined && value > row.impressions)
  if (violated) {
    throw new ZeusInvariantError(
      `${kind} ${subject} (entity ${entity.externalId}) on ${row.date}: ${violated[0]} ${String(violated[1])} > impressions ${row.impressions}`,
    )
  }
  // Not a failure. Zeus's unique click count sits within a couple of percent of its click count
  // and lands slightly above it on some days (campaign 18, August 2026: 13 of 31 days). The value
  // is stored as reported: it is a per-day scalar that is never added up, so it cannot inflate a
  // total, and the warning keeps the contradiction visible on the run.
  if (row.unique_clicks !== undefined && row.unique_clicks > row.clicks) {
    warn(
      `${kind} ${subject} on ${row.date}: Zeus reports unique_clicks ${row.unique_clicks} > clicks ${row.clicks}; stored as reported`,
    )
  }
}

/**
 * RFC-003 §2.2: Zeus has no range totals, so the run asserts internal consistency instead —
 * on every report it consumes. A day may appear once per creative, campaign and pixel; ratios
 * must hold; counts are non-negative integers (enforced by the schema). Unique clicks above clicks
 * is reported through `warn` and stored, never thrown (see checkDelivery).
 */
export function checkZeusInvariants(
  input: Pick<ZeusMapperInput, 'creatives' | 'campaigns' | 'tracker'>,
  warn: (message: string) => void = () => undefined,
): void {
  const seen = new Set<string>()
  const once = (key: string, message: string) => {
    if (seen.has(key)) throw new ZeusInvariantError(message)
    seen.add(key)
  }
  for (const { entity, row } of input.creatives) {
    once(
      `creative|${row.creative_id}|${row.date}`,
      `creative ${row.creative_id} appears twice for ${row.date}`,
    )
    checkDelivery('creative', entity, row, row.creative_id, warn)
  }
  for (const { entity, row } of input.campaigns) {
    once(
      `campaign|${row.campaign_id}|${row.date}`,
      `campaign ${row.campaign_id} appears twice for ${row.date}`,
    )
    checkDelivery('campaign', entity, row, row.campaign_id, warn)
  }
  for (const { row } of input.tracker) {
    once(`pixel|${row.pixel_id}|${row.date}`, `pixel ${row.pixel_id} appears twice for ${row.date}`)
  }
}

export function mapZeusRows(
  input: ZeusMapperInput,
  warn: (message: string) => void = () => undefined,
): CanonicalDailyRow[] {
  const rows: CanonicalDailyRow[] = []
  const newRow = (date: IsoDate, campaignTag: string): CanonicalDailyRow => {
    const row: CanonicalDailyRow = {
      date,
      language: input.language,
      campaignTag,
      metrics: {},
      pageViews: [],
      ctaClicks: [],
      unmapped: new Map(),
    }
    rows.push(row)
    return row
  }

  const delivery: Matched<DeliveryRow>[] = [...input.creatives, ...input.campaigns]
  for (const { entity, row: src } of delivery) {
    const row = newRow(src.date, entity.campaignTag)
    row.metrics.impressions = src.impressions
    row.metrics.in_view = src.visible_impressions
    if (src.unique_impressions !== undefined)
      row.metrics.unique_impressions_reported = src.unique_impressions
    if (src.unique_clicks !== undefined) row.metrics.unique_clicks_reported = src.unique_clicks
    row.ctaClicks.push({ ctaId: input.clickthroughCtaId, count: src.clicks })
  }

  for (const { entity, row: src } of input.tracker) {
    const row = newRow(src.date, entity.campaignTag)
    if (entity.role === 'engagement') row.metrics.game_started = src.fires
    else if (entity.role === 'finish') row.metrics.game_finished = src.fires
  }

  for (const { label, date, fires } of input.unmatchedPixels) {
    // Unmatched pixels are a link-level "map this" signal; they carry no tag.
    newRow(date, '').unmapped.set(label, fires)
  }

  return mergeRows(rows, warn)
}
