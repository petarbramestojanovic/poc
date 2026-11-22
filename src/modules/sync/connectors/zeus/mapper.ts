import type { IsoDate } from '../../../../core/dates.ts'
import { VerificationError } from '../../errors.ts'
import { mergeRows } from '../../merge.ts'
import type { CanonicalDailyRow, DeviceType, LinkEntity, MetricId } from '../../types.ts'
import { reportedId, type PixelRole } from './match.ts'
import type {
  ZeusCampaignsRow,
  ZeusCreativesRow,
  ZeusDevicesRow,
  ZeusTrackerRow,
} from './schema.ts'

// Pure. Delivery rows (creatives or campaigns), device rows and pixel fires become one row per
// (entity, date), merged per (date, campaign_tag) by the shared aggregation rules: counts add,
// the per-day unique_* scalars are never added across entities. A row lands on the tag of the
// entity it was matched to (match.ts): a creative's tag, or '' for the campaign's own row.
// Metrics Zeus does not measure are absent, never zero.

export interface Matched<T> {
  entity: LinkEntity
  row: T
}

/** A tracker row with the entity it counts for and what it counts. */
export interface CountedPixel extends Matched<ZeusTrackerRow> {
  role: PixelRole
}

export interface ZeusMapperInput {
  language: string
  clickthroughCtaId: string
  creatives: Matched<ZeusCreativesRow>[]
  campaigns: Matched<ZeusCampaignsRow>[]
  /** Device rows of the link's campaign or of one of its creatives. */
  devices: Matched<ZeusDevicesRow>[]
  tracker: CountedPixel[]
  /** Tracker rows of the link's own pixels that nothing gives a role, already labelled. */
  unmappedPixels: { label: string; date: IsoDate; fires: number }[]
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
  row: DeliveryRow,
  subject: string,
  warn: (message: string) => void,
): void {
  // A broken ratio is not a failure. The day is stored as Zeus reported it, never clamped, and the
  // warning keeps the contradiction visible on the run.
  const counts: [string, number | undefined][] = [
    ['clicks', row.clicks],
    ['visible_impressions', row.visible_impressions],
    ['unique_impressions', row.unique_impressions],
  ]
  for (const [name, value] of counts) {
    if (value !== undefined && value > row.impressions) {
      warn(
        `${kind} ${subject} on ${row.date}: Zeus reports ${name} ${value} > impressions ${row.impressions}; stored as reported`,
      )
    }
  }
  // Zeus's unique click count sits within a couple of percent of its click count and lands
  // slightly above it on some days (campaign 18, August 2026: 13 of 31 days).
  if (row.unique_clicks !== undefined && row.unique_clicks > row.clicks) {
    warn(
      `${kind} ${subject} on ${row.date}: Zeus reports unique_clicks ${row.unique_clicks} > clicks ${row.clicks}; stored as reported`,
    )
  }
}

/** The metric a pixel's fires are, by what the pixel counts. */
const PIXEL_METRIC: Readonly<Record<PixelRole, MetricId>> = {
  engagement: 'game_started',
  finish: 'game_finished',
}

/** The device names Zeus documents, onto ours. Its empty value means it could not tell. */
const ZEUS_DEVICE_TYPES: ReadonlyMap<string, DeviceType> = new Map([
  ['desktop', 'desktop'],
  ['mobile', 'mobile'],
  ['tablet', 'tablet'],
  ['', 'unknown'],
])

const reportedDevice = (row: ZeusDevicesRow): string => (row.device_type ?? '').trim().toLowerCase()

/** Whose device row it is, as the reports name it. */
const deviceOwner = (row: ZeusDevicesRow): string => reportedId(row.external_id, row.campaign_id)

/**
 * The device rows a link stores: one level per day. A day with device rows for the link's
 * creatives is split by creative, and the campaign's own rows of that day are left out, the way
 * a divided campaign's own delivery row is read and never written. Storing both would count the
 * day twice in every read that adds a campaign's rows up.
 */
export function deviceRowsToStore(
  devices: readonly Matched<ZeusDevicesRow>[],
): Matched<ZeusDevicesRow>[] {
  const divided = new Set(
    devices.filter((d) => d.entity.level === 'creative').map((d) => d.row.date),
  )
  return devices.filter((d) => d.entity.level === 'creative' || !divided.has(d.row.date))
}

/**
 * The device split against the delivery it splits. Rows that do not add up to the delivery
 * report's impressions are a warning, stored as reported like every other number Zeus
 * contradicts itself on; a day the delivery report has no row for has nothing to compare with.
 * On the real account the two agree to the impression (checked 2026-11-22).
 */
function checkDeviceSplit(
  input: Pick<ZeusMapperInput, 'creatives' | 'campaigns' | 'devices'>,
  warn: (message: string) => void,
): void {
  const split = new Map<string, { entity: LinkEntity; date: IsoDate; impressions: number }>()
  const key = (entity: LinkEntity, date: IsoDate) => `${entity.level}|${entity.externalId}|${date}`

  for (const { entity, row } of input.devices) {
    const entry = split.get(key(entity, row.date)) ?? { entity, date: row.date, impressions: 0 }
    entry.impressions += row.impressions
    split.set(key(entity, row.date), entry)
  }

  const delivered = new Map<string, number>()
  for (const { entity, row } of [...input.creatives, ...input.campaigns]) {
    const at = key(entity, row.date)
    delivered.set(at, (delivered.get(at) ?? 0) + row.impressions)
  }
  for (const [at, { entity, date, impressions }] of split) {
    const expected = delivered.get(at)
    if (expected === undefined || expected === impressions) continue
    const report = entity.level === 'creative' ? 'creatives' : 'campaigns'
    warn(
      `devices: ${entity.externalId} on ${date}: the device rows add up to ${impressions} impressions, the ${report} report has ${expected}; stored as reported`,
    )
  }
}

/**
 * RFC-003 §2.2: Zeus has no range totals, so the run asserts internal consistency instead —
 * on every report it consumes. A day may appear once per creative, campaign, device and pixel
 * (thrown); counts are non-negative integers (enforced by the schema). A broken ratio — clicks,
 * visible or unique impressions above impressions, unique clicks above clicks — is reported
 * through `warn` and stored as reported, never thrown (see checkDelivery). The device split is
 * also checked against the delivery (see checkDeviceSplit).
 */
export function checkZeusInvariants(
  input: Pick<ZeusMapperInput, 'creatives' | 'campaigns' | 'devices' | 'tracker'>,
  warn: (message: string) => void = () => undefined,
): void {
  const seen = new Set<string>()
  const once = (key: string, message: string) => {
    if (seen.has(key)) throw new ZeusInvariantError(message)
    seen.add(key)
  }
  for (const { row } of input.creatives) {
    once(
      `creative|${row.creative_id}|${row.date}`,
      `creative ${row.creative_id} appears twice for ${row.date}`,
    )
    checkDelivery('creative', row, row.creative_id, warn)
  }
  for (const { row } of input.campaigns) {
    once(
      `campaign|${row.campaign_id}|${row.date}`,
      `campaign ${row.campaign_id} appears twice for ${row.date}`,
    )
    checkDelivery('campaign', row, row.campaign_id, warn)
  }
  for (const { row } of input.devices) {
    const subject = `${reportedDevice(row) || 'unknown'} of ${deviceOwner(row)}`
    once(
      `device|${row.campaign_id}|${deviceOwner(row)}|${reportedDevice(row)}|${row.date}`,
      `device ${subject} appears twice for ${row.date}`,
    )
    checkDelivery('device', row, subject, warn)
  }
  checkDeviceSplit(input, warn)
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
      devices: [],
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

  // A device Zeus names in a way we do not know is still delivery: it is counted as `unknown`,
  // so the devices keep adding up, and named once on the run so it does not go unnoticed.
  const strangeDevices = new Set<string>()
  for (const { entity, row: src } of deviceRowsToStore(input.devices)) {
    const reported = reportedDevice(src)
    const deviceType = ZEUS_DEVICE_TYPES.get(reported)
    if (deviceType === undefined && !strangeDevices.has(reported)) {
      strangeDevices.add(reported)
      warn(
        `devices: Zeus names a device "${reported}" we do not know; its rows are counted as unknown`,
      )
    }
    newRow(src.date, entity.campaignTag).devices.push({
      deviceType: deviceType ?? 'unknown',
      impressions: src.impressions,
      inView: src.visible_impressions,
      clicks: src.clicks,
    })
  }

  for (const { entity, role, row: src } of input.tracker) {
    newRow(src.date, entity.campaignTag).metrics[PIXEL_METRIC[role]] = src.fires
  }

  for (const { label, date, fires } of input.unmappedPixels) {
    // A pixel nothing gives a role is a link-level "map this" signal; it carries no tag.
    newRow(date, '').unmapped.set(label, fires)
  }

  return mergeRows(rows, warn)
}
