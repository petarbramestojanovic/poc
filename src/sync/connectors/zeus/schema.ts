import { z } from 'zod'

// The four Zeus reports (https://t.zeus.ad/api/doc): daily aggregates, complete days only,
// latest day is always yesterday. Loose objects: extra fields are tolerated and ignored.

const id = z.union([z.number(), z.string()]).transform(String)
const optionalText = z.string().nullable().optional()

export const zeusCreativesRow = z.looseObject({
  date: z.string(),
  campaign_id: id,
  external_id: optionalText,
  creative_id: id,
  creative_name: optionalText,
  impressions: z.number(),
  unique_impressions: z.number(),
  clicks: z.number(),
  unique_clicks: z.number(),
  visible_impressions: z.number(),
  // ctr / visibility are ratios; never stored (RFC-003 §2.2).
})
export type ZeusCreativesRow = z.infer<typeof zeusCreativesRow>

export const zeusTrackerRow = z.looseObject({
  date: z.string(),
  pixel_id: id,
  external_id: optionalText,
  code: optionalText,
  name: optionalText,
  fires: z.number(),
})
export type ZeusTrackerRow = z.infer<typeof zeusTrackerRow>

export const zeusCampaignsRow = z.looseObject({
  date: z.string(),
  campaign_id: id,
  external_id: optionalText,
  name: optionalText,
  impressions: z.number(),
  unique_impressions: z.number().optional(),
  clicks: z.number(),
  unique_clicks: z.number().optional(),
  visible_impressions: z.number(),
})
export type ZeusCampaignsRow = z.infer<typeof zeusCampaignsRow>

export function zeusReport<T extends z.ZodType>(row: T) {
  return z.looseObject({
    customer: z.unknown().optional(),
    from: z.string(),
    to: z.string(),
    rows: z.array(row),
  })
}

export const zeusLinkConfig = z
  .object({
    /** analytics.cta.cta_id that /reports/creatives clicks are written to. */
    clickthroughCtaId: z.string().min(1),
    /** Which query parameter carries the campaign id when filtering reports. */
    campaignIdParam: z.enum(['external_id', 'internal_id']).default('external_id'),
  })
  .strict()
export type ZeusLinkConfig = z.infer<typeof zeusLinkConfig>
