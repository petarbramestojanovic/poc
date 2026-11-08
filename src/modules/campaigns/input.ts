import { z } from 'zod'
import { externalRefSchema } from '../../core/external-ref.ts'
import { ianaTimezone } from '../../core/schemas.ts'
import { companyRefSchema } from '../companies/input.ts'

// What it takes to set a campaign up, in our own vocabulary and nothing else. This is the one
// input the setup service understands: the Salesforce webhook (modules/salesforce/) builds this
// shape and hands it over, and so would any other CRM. Nothing here knows about Zeus, NEXD or
// Salesforce — platform shortcuts live in presets.ts, and a CRM's field names stay in that CRM's
// adapter.

const name = z.string().trim().min(1).max(200)

export const ENTITY_LEVELS = [
  'campaign',
  'creative',
  'pixel',
  'line_item',
  'placement',
  'order',
] as const

export const entitySetupSchema = z.strictObject({
  level: z.enum(ENTITY_LEVELS),
  /** The platform's own id for it. */
  externalId: z.string().trim().min(1).max(255),
  role: z.string().trim().min(1).max(64).optional(),
  label: name.optional(),
  /**
   * The creative this entity's rows belong to, by its tag (app.creative.tag): what the writer
   * stamps on them. Left out on a creative entity, the service gives a new creative its own id
   * as tag, and an entity the link already has keeps the creative it points at. '' keeps the rows
   * on the campaign's own row, which is what every other level means by leaving it out. A pixel
   * naming a tag must name a creative the campaign has.
   */
  campaignTag: z.string().trim().max(200).optional(),
  /** The creative's type as the CRM names it ('Swipe Card'); creative entities only, optional. */
  creativeType: name.optional(),
})
export type EntitySetup = z.infer<typeof entitySetupSchema>

const ctaSetupSchema = z.strictObject({
  ctaId: z.string().trim().min(1).max(100),
  name,
  url: z.url().optional(),
  isInternalEvent: z.boolean().default(false),
  sortOrder: z.int().optional(),
})

const pageSetupSchema = z.strictObject({
  pageId: z.string().trim().min(1).max(100),
  name,
  sortOrder: z.int().optional(),
})

const eventMapSetupSchema = z.strictObject({
  eventName: z.string().min(1).max(300),
  targetKind: z.enum(['metric', 'page_view', 'cta_click', 'ignore']),
  targetId: z.string().min(1).max(100).optional(),
})

/** One link: a source, a language slice, and the platform ids that feed it. */
export const sourceSetupSchema = z.strictObject({
  source: z.string().min(1),
  /** '' = the campaign is not split by language on this source. */
  language: z.string().trim().max(16).default(''),
  /** Credential name or id. May be left out while the source has exactly one enabled credential. */
  credential: z.string().trim().min(1).optional(),
  /** external.campaign_link.config, validated against the connector's own schema. */
  config: z.record(z.string(), z.unknown()).default({}),
  entities: z.array(entitySetupSchema).min(1),
  ctas: z.array(ctaSetupSchema).default([]),
  pages: z.array(pageSetupSchema).default([]),
  eventMap: z.array(eventMapSetupSchema).default([]),
})
export type SourceSetup = z.infer<typeof sourceSetupSchema>

const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf('currency'))

const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'an ISO 4217 code such as "EUR"')
  .refine((code) => KNOWN_CURRENCIES.has(code), { error: 'not an ISO 4217 currency' })

/**
 * What the client pays for 1000 impressions (CPM), in `currency`. `value` is a JSON number with
 * at most six decimals: that is what app.campaign.price (numeric(14,6), migration 0009) holds
 * exactly, and Postgres would round a seventh silently. Its decimal text is what gets stored, so
 * 5.31686 reads back as 5.31686.
 */
export const priceSchema = z.strictObject({
  value: z
    .number()
    .min(0)
    .max(99_999_999.999999)
    .refine((value) => /^\d+(\.\d{1,6})?$/.test(String(value)), {
      error: 'at most 6 decimal places',
    }),
  currency: currencySchema,
})
export type Price = z.infer<typeof priceSchema>

/**
 * A deal's total, in `currency`. At most two decimals, for the same reason as the price:
 * app.campaign.amount is numeric(14,2) (migration 0010) and Postgres would round a third.
 */
export const amountSchema = z.strictObject({
  value: z
    .number()
    .min(0)
    .max(999_999_999_999.99)
    .refine((value) => /^\d+(\.\d{1,2})?$/.test(String(value)), {
      error: 'at most 2 decimal places',
    }),
  currency: currencySchema,
})
export type Amount = z.infer<typeof amountSchema>

export const dealTextSchema = name

export const creativeTypesSchema = z.array(dealTextSchema).min(1).max(50)

/** With its offset, and stored in one spelling, so one instant sent twice is not a change. */
export const dealTimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

/** The CRM's id of the person: a name without one could not tell two namesakes apart. */
export const managerSchema = z.strictObject({
  id: z.string().trim().min(1).max(255),
  name: dealTextSchema.optional(),
})

export const CAMPAIGN_STATUSES = ['draft', 'active', 'archived'] as const

/** The campaign's own fields. A person never edits them: they come from the CRM push. */
export const campaignFields = {
  name,
  /** Whose numbers are the headline. Left out: presets.ts headlineSource decides on creation. */
  primarySource: z.string().min(1).optional(),
  timezone: ianaTimezone.optional(),
  languages: z.array(z.string().trim().min(1).max(16)).max(20).optional(),
  startsOn: z.iso.date().nullable().optional(),
  endsOn: z.iso.date().nullable().optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  /** A push, like with the dates, can never clear it. */
  price: priceSchema.nullable().optional(),
  // What the CRM says about the deal behind the campaign. It describes: no sync, report or rule
  // reads it. A push can change these but never clear them.
  amount: amountSchema.optional(),
  dealType: dealTextSchema.optional(),
  country: dealTextSchema.optional(),
  creativeTypes: creativeTypesSchema.optional(),
  ownerName: dealTextSchema.optional(),
  manager: managerSchema.optional(),
  externalModifiedAt: dealTimestampSchema.optional(),
}

/** Shared by every schema that carries both dates. */
export const startsBeforeEnd = (value: {
  startsOn?: string | null | undefined
  endsOn?: string | null | undefined
}): boolean => value.startsOn == null || value.endsOn == null || value.startsOn <= value.endsOn

export const campaignSetupSchema = z
  .strictObject({
    /** Set by a caller that will push this campaign again; omitted for one typed in by hand. */
    externalRef: externalRefSchema.optional(),
    company: companyRefSchema,
    ...campaignFields,
    sources: z.array(sourceSetupSchema).default([]),
  })
  .refine(startsBeforeEnd, { error: 'endsOn is before startsOn', path: ['endsOn'] })
export type CampaignSetup = z.infer<typeof campaignSetupSchema>
