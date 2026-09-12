import { z } from 'zod'

// Only the parts of POST /analytics/creatives/{live_id} we read. Loose objects: NEXD may add
// fields at any time. `performance[].date` is what the API returns today (undocumented); the
// spec documents `dt`, so both are accepted.

export const nexdEventItem = z.looseObject({
  action: z.looseObject({ original: z.string() }),
  count: z.number(),
  u_count: z.number().optional(),
})
export type NexdEventItem = z.infer<typeof nexdEventItem>

export const nexdPerformanceItem = z.looseObject({
  date: z.string().optional(),
  dt: z.union([z.number(), z.string()]).optional(),
  impressions: z.number(),
  loaded: z.number().optional(),
  viewable: z.looseObject({ value: z.number() }),
  engagement: z.looseObject({ value: z.number() }),
  ctr: z.looseObject({ value: z.number() }).optional(),
  /** Average dwell per engaged user, milliseconds. */
  dwell: z.number(),
})
export type NexdPerformanceItem = z.infer<typeof nexdPerformanceItem>

export const nexdTotals = z.looseObject({
  impressions: z.number(),
  viewable: z.number(),
  engagement: z.looseObject({ clicks: z.number() }),
})
export type NexdTotals = z.infer<typeof nexdTotals>

export const nexdAnalytics = z.looseObject({
  performance: z.array(nexdPerformanceItem),
  /** Per-day events keyed by YYYY-MM-DD. Undocumented; the connector falls back to `events`. */
  eventsList: z.record(z.string(), z.array(nexdEventItem)).optional(),
  /** Documented range totals. */
  events: z.array(nexdEventItem).optional(),
  summary: z.looseObject({ totals: nexdTotals }).optional(),
})

export const nexdResponse = z.looseObject({
  result: z.looseObject({ analytics: nexdAnalytics }),
})
export type NexdResponse = z.infer<typeof nexdResponse>

export const nexdLinkConfig = z.object({}).strict()
export type NexdLinkConfig = z.infer<typeof nexdLinkConfig>
