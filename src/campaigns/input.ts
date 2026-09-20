import { z } from 'zod'
import { ianaTimezone } from '../schemas.ts'

// What it takes to set a campaign up, in our own vocabulary and nothing else. This is the one
// input the setup service understands: a form, a CSV import or a CRM push all build this shape
// and hand it over. Nothing here knows about Zeus, NEXD or Salesforce — platform shortcuts live
// in presets.ts, and a CRM's field names stay in that CRM's adapter.

const name = z.string().trim().min(1).max(200)

/** Who owns the id a caller knows this record by (migration 0004). */
export const externalRefSchema = z.strictObject({
  system: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'a short lowercase slug such as "salesforce"'),
  id: z.string().trim().min(1).max(255),
})
export type ExternalRef = z.infer<typeof externalRefSchema>

/** An existing company by our id, or a company described well enough to create or find it. */
export const companyRefSchema = z.union([
  z.strictObject({ id: z.guid() }),
  z.strictObject({ name, externalRef: externalRefSchema.optional() }),
])
export type CompanyRef = z.infer<typeof companyRefSchema>

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
  /** What the writer stamps on rows from this entity; '' keeps them on the campaign's own row. */
  campaignTag: z.string().trim().max(200).default(''),
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

export const CAMPAIGN_STATUSES = ['draft', 'active', 'archived'] as const

/** The campaign's own fields: shared by a setup and by an edit. */
export const campaignFields = {
  name,
  /** Whose numbers are the headline. May be left out when the setup has exactly one source. */
  primarySource: z.string().min(1).optional(),
  timezone: ianaTimezone.optional(),
  languages: z.array(z.string().trim().min(1).max(16)).max(20).optional(),
  startsOn: z.iso.date().nullable().optional(),
  endsOn: z.iso.date().nullable().optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
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

/** An edit: any of the campaign's own fields, at least one. Links are not edited here. */
export const campaignPatchSchema = z
  .strictObject({ ...campaignFields, name: name.optional() })
  .refine((patch) => Object.keys(patch).length > 0, { error: 'nothing to change' })
  .refine(startsBeforeEnd, { error: 'endsOn is before startsOn', path: ['endsOn'] })
export type CampaignPatch = z.infer<typeof campaignPatchSchema>
