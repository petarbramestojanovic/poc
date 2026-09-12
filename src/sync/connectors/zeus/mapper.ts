import type { IsoDate } from '../../../dates.ts'
import type { CanonicalDailyRow, LinkEntity } from '../../types.ts'
import type { ZeusCampaignsRow, ZeusCreativesRow, ZeusTrackerRow } from './schema.ts'

// Pure. Delivery rows (creatives or campaigns) and pixel fires are merged per (date, campaign_tag):
// a pixel's fires land on the tag its link_entity carries, which an operator sets to its
// creative's tag. Metrics Zeus does not measure are absent, never zero.

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

export class ZeusInvariantError extends Error {
  override readonly name = 'ZeusInvariantError'
}

/** RFC-003 §2.2: Zeus has no range totals, so the run asserts internal consistency instead. */
export function checkZeusInvariants(creatives: Matched<ZeusCreativesRow>[]): void {
  const seen = new Set<string>()
  for (const { entity, row } of creatives) {
    const key = `${entity.externalId}|${row.date}`
    if (seen.has(key)) {
      throw new ZeusInvariantError(`creative ${entity.externalId} appears twice for ${row.date}`)
    }
    seen.add(key)
    const violated = [
      ['clicks', row.clicks],
      ['visible_impressions', row.visible_impressions],
      ['unique_impressions', row.unique_impressions],
    ].find(([, value]) => (value as number) > row.impressions)
    if (violated) {
      throw new ZeusInvariantError(
        `creative ${entity.externalId} on ${row.date}: ${violated[0] as string} ${violated[1] as number} > impressions ${row.impressions}`,
      )
    }
  }
}

export function mapZeusRows(input: ZeusMapperInput): CanonicalDailyRow[] {
  const rows = new Map<string, CanonicalDailyRow>()
  const rowFor = (date: IsoDate, campaignTag: string): CanonicalDailyRow => {
    const key = `${date}|${campaignTag}`
    let row = rows.get(key)
    if (!row) {
      row = {
        date,
        language: input.language,
        campaignTag,
        metrics: {},
        pageViews: [],
        ctaClicks: [],
        unmapped: {},
      }
      rows.set(key, row)
    }
    return row
  }
  const add = (row: CanonicalDailyRow, id: keyof CanonicalDailyRow['metrics'], value: number) => {
    row.metrics[id] = (row.metrics[id] ?? 0) + value
  }

  const delivery = [...input.creatives, ...input.campaigns]
  for (const { entity, row: src } of delivery) {
    const row = rowFor(src.date, entity.campaignTag)
    add(row, 'impressions', src.impressions)
    add(row, 'in_view', src.visible_impressions)
    if (src.unique_impressions !== undefined)
      add(row, 'unique_impressions_reported', src.unique_impressions)
    if (src.unique_clicks !== undefined) add(row, 'unique_clicks_reported', src.unique_clicks)
    const cta = row.ctaClicks.find((c) => c.ctaId === input.clickthroughCtaId)
    if (cta) cta.count += src.clicks
    else row.ctaClicks.push({ ctaId: input.clickthroughCtaId, count: src.clicks })
  }

  for (const { entity, row: src } of input.tracker) {
    const row = rowFor(src.date, entity.campaignTag)
    if (entity.role === 'engagement') add(row, 'game_started', src.fires)
    else if (entity.role === 'finish') add(row, 'game_finished', src.fires)
  }

  for (const { label, date, fires } of input.unmatchedPixels) {
    // Unmatched pixels are a link-level "map this" signal; they carry no tag.
    const row = rowFor(date, '')
    row.unmapped[label] = (row.unmapped[label] ?? 0) + fires
  }

  return [...rows.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.campaignTag.localeCompare(b.campaignTag),
  )
}
