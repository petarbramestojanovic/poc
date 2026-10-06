import { z } from 'zod'

// The webhook body, version 1 (RFC-002 §15.4, docs/WEBHOOK-PAYLOAD-v1.md). Postgres builds it —
// app.build_webhook_payload (migrations 0003 and 0007) — and this schema is the contract that build
// answers to: an integration test parses the real payload with it, so a change on either side has
// to be a change on both. A webhook with a field list (src/webhooks/fields.ts) sends a narrower
// body with calculated keys; webhookPayloadSchemaFor describes that one.
//
// Two shapes of "no value" mean different things and both survive the round trip:
//   * a metric key is ABSENT when the source does not measure it (it is not in external.source_metric),
//     or when the webhook's field list leaves it out,
//   * a metric key is NULL when it is measured but has no value for that range — including the two
//     `unique_*_reported` per-day scalars, which are never added up and so are null in every total.

const count = z.int().nonnegative().nullable().optional()
const average = z.number().nonnegative().nullable().optional()

/**
 * The twelve analytics.advanced_analytics metrics. Strict: an unknown key means the database is
 * sending something this contract does not describe. A unit test pins these keys to METRIC_IDS.
 */
export const metricsSchema = z.strictObject({
  impressions: count,
  in_view: count,
  game_started: count,
  game_finished: count,
  interactions: count,
  hovered: count,
  in_view_time: count,
  dwell_time: count,
  interaction_time: count,
  dwell_avg_ms: average,
  unique_impressions_reported: count,
  unique_clicks_reported: count,
})

/** Range totals: same metrics, except the two per-day scalars, which cannot be summed over days. */
const totalsSchema = metricsSchema.refine(
  (totals) => totals.unique_impressions_reported == null && totals.unique_clicks_reported == null,
  { error: 'unique_*_reported is a per-day scalar and must be null in a range total' },
)

const dailyEntrySchema = z.strictObject({
  date: z.iso.date(),
  language: z.string(),
  ...metricsSchema.shape,
})

const creativeSchema = z.strictObject({
  campaign_tag: z.string(),
  label: z.string().nullable(),
  totals: totalsSchema,
})

const ctaSchema = z.strictObject({
  cta_id: z.string(),
  name: z.string(),
  is_internal_event: z.boolean(),
  count: z.int().nonnegative(),
})

const pageSchema = z.strictObject({
  page_id: z.string(),
  name: z.string(),
  count: z.int().nonnegative(),
})

/**
 * One source's own series. `role` names the campaign's headline source; check sources are shown
 * beside it for comparison and are never added to it (RFC-003 §4.1).
 */
export const sourceBlockSchema = z.strictObject({
  source: z.string(),
  display_name: z.string(),
  role: z.enum(['primary', 'check']),
  day_timezone: z.string(),
  /** Last day fully written for every link of this campaign; null before the first sync. */
  data_complete_through: z.iso.date().nullable(),
  last_synced_at: z.iso.datetime().nullable(),
  /** Exactly the metrics this source measures; every other metric key is absent below. */
  metrics_available: z.array(z.string()),
  totals: totalsSchema,
  daily: z.array(dailyEntrySchema),
  creatives: z.array(creativeSchema),
  ctas: z.array(ctaSchema),
  pages: z.array(pageSchema),
})

const campaignSchema = z.strictObject({
  id: z.guid(),
  name: z.string(),
  primary_source: z.string(),
  sources: z.array(sourceBlockSchema),
})

const envelope = {
  version: z.literal(1),
  /** app.webhook_delivery.id, the same value as the X-Delivery-Id header; stamped at insert. */
  delivery_id: z.guid().nullable(),
  generated_at: z.iso.datetime(),
  period: z.strictObject({
    start: z.iso.date(),
    end: z.iso.date(),
    timezone: z.string(),
    window: z.enum(['previous_day', 'previous_week', 'previous_month']),
  }),
  company: z.strictObject({ id: z.guid(), name: z.string() }),
}

/** The full v1 body: what Postgres builds, and what a webhook without a field list sends. */
export const webhookPayloadSchema = z.strictObject({
  ...envelope,
  campaigns: z.array(campaignSchema),
})

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>
export type WebhookSourceBlock = z.infer<typeof sourceBlockSchema>
export type WebhookCampaign = z.infer<typeof campaignSchema>
export type WebhookMetrics = z.infer<typeof metricsSchema>

/** The lists of a source block a webhook's field list can leave out (src/webhooks/fields.ts). */
export const PAYLOAD_SECTIONS = ['daily', 'ctas', 'pages'] as const
export type PayloadSection = (typeof PAYLOAD_SECTIONS)[number]

/** What a field list changes in the body, as far as the contract is concerned. */
export interface PayloadShape {
  /** The lists that are present; the others are absent, not empty. */
  sections: readonly PayloadSection[]
  /** Names of the calculated fields, present in every metrics object of their source's block. */
  calculated: readonly string[]
  /** Whether each campaign carries its `price` and `currency` (a formula uses the price). */
  price: boolean
}

/**
 * The contract for the body of one webhook with a field list: the v1 schema with that list's
 * sections, calculated keys and campaign price. Strict like the full schema, so a key the field
 * list does not produce is still refused. Metrics a list leaves out are simply absent, which the
 * full schema already allows.
 */
export function webhookPayloadSchemaFor(shape: PayloadShape): z.ZodType {
  const calculated = z.number().nullable().optional()
  const metrics = metricsSchema.extend(
    Object.fromEntries(shape.calculated.map((name) => [name, calculated])),
  )
  const totals = metrics.refine(
    (values) => values.unique_impressions_reported == null && values.unique_clicks_reported == null,
    { error: 'unique_*_reported is a per-day scalar and must be null in a range total' },
  )
  const has = (section: PayloadSection) => shape.sections.includes(section)

  const block = sourceBlockSchema.omit({ daily: true, ctas: true, pages: true }).extend({
    totals,
    creatives: z.array(creativeSchema.extend({ totals })),
    ...(has('daily')
      ? {
          daily: z.array(
            z.strictObject({ date: z.iso.date(), language: z.string(), ...metrics.shape }),
          ),
        }
      : {}),
    ...(has('ctas') ? { ctas: z.array(ctaSchema) } : {}),
    ...(has('pages') ? { pages: z.array(pageSchema) } : {}),
  })

  const campaign = campaignSchema.extend({
    ...(shape.price
      ? { price: z.number().nonnegative().nullable(), currency: z.string().nullable() }
      : {}),
    sources: z.array(block),
  })

  return z.strictObject({ ...envelope, campaigns: z.array(campaign) })
}
