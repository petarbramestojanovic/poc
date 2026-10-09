import { z } from 'zod'

// The four Zeus reports (https://t.zeus.ad/api/doc): daily aggregates, complete days only,
// latest day is always yesterday. Loose objects: extra fields are tolerated and ignored.
// Every day is a real calendar date; a malformed one fails the parse, never becomes a row key.

const id = z.union([z.number(), z.string()]).transform(String)
const optionalText = z.string().nullable().optional()
const count = z.number().int().nonnegative()

export const zeusCreativesRow = z.looseObject({
  date: z.iso.date(),
  campaign_id: id,
  external_id: optionalText,
  creative_id: id,
  creative_name: optionalText,
  impressions: count,
  unique_impressions: count,
  clicks: count,
  unique_clicks: count,
  visible_impressions: count,
  // ctr / visibility are ratios; never stored (RFC-003 §2.2).
})
export type ZeusCreativesRow = z.infer<typeof zeusCreativesRow>

export const zeusTrackerRow = z.looseObject({
  date: z.iso.date(),
  pixel_id: id,
  external_id: optionalText,
  code: optionalText,
  name: optionalText,
  fires: count,
})
export type ZeusTrackerRow = z.infer<typeof zeusTrackerRow>

export const zeusCampaignsRow = z.looseObject({
  date: z.iso.date(),
  campaign_id: id,
  external_id: optionalText,
  name: optionalText,
  impressions: count,
  unique_impressions: count.optional(),
  clicks: count,
  unique_clicks: count.optional(),
  visible_impressions: count,
})
export type ZeusCampaignsRow = z.infer<typeof zeusCampaignsRow>

export function zeusReport<T extends z.ZodType>(row: T) {
  return z.looseObject({
    customer: z.unknown().optional(),
    from: z.iso.date(),
    to: z.iso.date(),
    rows: z.array(row),
  })
}

export const zeusLinkConfig = z
  .object({
    /** analytics.cta.cta_id that /reports/creatives clicks are written to. */
    clickthrough_cta_id: z.string().min(1),
    /** Which query parameter carries the campaign id when filtering reports. */
    campaign_id_param: z.enum(['external_id', 'internal_id']).default('external_id'),
  })
  .strict()
export type ZeusLinkConfig = z.infer<typeof zeusLinkConfig>
