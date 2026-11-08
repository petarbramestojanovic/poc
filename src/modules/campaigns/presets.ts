import { z } from 'zod'
import { sourceSetupSchema, type SourceSetup } from './input.ts'

// Shortcuts from "the ids a person has at hand" to a full SourceSetup. The setup service itself is
// platform-neutral; everything a platform needs by convention — the CTA Zeus clicks are written
// to, the two NEXD events that mean the same thing in every creative — is decided here, once, so
// the console form and a future CRM adapter set a campaign up identically.
//
// A new platform is one schema and one function in this file, plus its key in PLATFORM_PRESETS
// (and in HEADLINE_ORDER, if it may be a headline).

const id = z.union([z.string(), z.number()]).transform((value) => String(value).trim())
const nonEmptyId = id.refine((value) => value.length > 0 && value.length <= 255, {
  error: 'must not be empty',
})
const label = z.string().trim().min(1).max(200).optional()
/**
 * The creative a tag names (app.creative.tag). Left out on a creative, the setup service makes
 * it one of ours, tagged with its own id. A pixel's tag must be one of the campaign's creatives.
 */
const tag = z.string().trim().max(200).optional()
/** The creative's type as the CRM names it; left out = not known. */
const creativeType = z.string().trim().min(1).max(200).optional()
const linkFields = {
  /** '' (the default) = not split by language. */
  language: z.string().trim().max(16).optional(),
  /** Credential name or id; only needed once a source has more than one. */
  credential: z.string().trim().min(1).optional(),
}

/** The CTA every Zeus link writes its clicks to (zeusLinkConfig.clickthrough_cta_id). */
export const CLICKTHROUGH_CTA = { ctaId: 'clickthrough', name: 'Click-out' } as const

export const zeusPresetSchema = z.strictObject({
  /** The Zeus campaign id, e.g. 18. */
  campaignId: nonEmptyId,
  /**
   * Which of Zeus's two ids that is. Required, never defaulted: the wrong one returns another
   * campaign's rows or nothing at all, so the caller has to say.
   */
  idType: z.enum(['internal_id', 'external_id']),
  /** ATK pixels: what gives an ATK campaign its game starts and finishes. */
  pixels: z
    .array(
      z.strictObject({
        code: nonEmptyId,
        role: z.enum(['engagement', 'finish']),
        label,
        /** The creative tag these fires belong to; '' = the campaign's own row. */
        tag,
      }),
    )
    .default([]),
  /** Optional per-creative breakdown. A new creative becomes one of ours, tagged with its own id. */
  creatives: z
    .array(z.strictObject({ id: nonEmptyId, label, tag, type: creativeType }))
    .default([]),
  ...linkFields,
})
export type ZeusPreset = z.infer<typeof zeusPresetSchema>

const defined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>

export function zeusSetup(input: ZeusPreset): SourceSetup {
  return sourceSetupSchema.parse({
    source: 'zeus',
    language: input.language ?? '',
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    config: { clickthrough_cta_id: CLICKTHROUGH_CTA.ctaId, campaign_id_param: input.idType },
    entities: [
      { level: 'campaign', externalId: input.campaignId, campaignTag: '' },
      ...input.creatives.map((creative) =>
        defined({
          level: 'creative',
          externalId: creative.id,
          label: creative.label,
          campaignTag: creative.tag,
          creativeType: creative.type,
        }),
      ),
      ...input.pixels.map((pixel) =>
        defined({
          level: 'pixel',
          externalId: pixel.code,
          role: pixel.role,
          label: pixel.label,
          campaignTag: pixel.tag ?? '',
        }),
      ),
    ],
    ctas: [CLICKTHROUGH_CTA],
  })
}

/** RFC-003 §2: the two NEXD event names that mean the same thing in every creative. */
export const NEXD_STANDARD_EVENTS = [
  { eventName: 'Unique [Touch]', targetKind: 'metric', targetId: 'interactions' },
  { eventName: 'Unique [Hover]', targetKind: 'metric', targetId: 'hovered' },
] as const

export const nexdPresetSchema = z.strictObject({
  /**
   * One entry per NEXD creative (live id). A new creative becomes one of ours, tagged with its
   * own id; `tag` names an existing creative instead (the same creative on another platform). The
   * label is the name a client sees for the creative's rows (NEXD's own API returns none), so it
   * is required here, unlike on Zeus, whose reports carry a creative_name.
   */
  creatives: z
    .array(z.strictObject({ liveId: nonEmptyId, label: label.unwrap(), tag, type: creativeType }))
    .min(1),
  ...linkFields,
})
export type NexdPreset = z.infer<typeof nexdPresetSchema>

export function nexdSetup(input: NexdPreset): SourceSetup {
  return sourceSetupSchema.parse({
    source: 'nexd',
    language: input.language ?? '',
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    entities: input.creatives.map((creative) =>
      defined({
        level: 'creative',
        externalId: creative.liveId,
        label: creative.label,
        campaignTag: creative.tag,
        creativeType: creative.type,
      }),
    ),
    // 'Page seen [...]' and 'CTR [...]' are named per creative, so they are not guessed here:
    // they arrive in external.unmapped_event and are mapped once someone has seen them.
    eventMap: [...NEXD_STANDARD_EVENTS],
  })
}

/** An id provisioning obtained for a creative (or the campaign), to be written as a link entity. */
export interface ProvisionedEntity {
  level: 'campaign' | 'creative'
  externalId: string
  /** The creative it names; null for the campaign's own id. */
  creative: { tag: string; name: string } | null
}

const provisionedEntitySetups = (entities: readonly ProvisionedEntity[]) =>
  entities.map((entity) =>
    defined({
      level: entity.level,
      externalId: entity.externalId,
      label: entity.creative?.name,
      campaignTag: entity.creative?.tag ?? '',
    }),
  )

/** The Zeus link provisioning writes: the derived strings, asked for by external id. */
export function zeusProvisionedSetup(entities: readonly ProvisionedEntity[]): SourceSetup {
  return sourceSetupSchema.parse({
    source: 'zeus',
    config: { clickthrough_cta_id: CLICKTHROUGH_CTA.ctaId, campaign_id_param: 'external_id' },
    entities: provisionedEntitySetups(entities),
    ctas: [CLICKTHROUGH_CTA],
  })
}

/** The NEXD link provisioning writes: the live ids it obtained, one per creative. */
export function nexdProvisionedSetup(entities: readonly ProvisionedEntity[]): SourceSetup {
  return sourceSetupSchema.parse({
    source: 'nexd',
    entities: provisionedEntitySetups(entities.filter((entity) => entity.level === 'creative')),
    eventMap: [...NEXD_STANDARD_EVENTS],
  })
}

/**
 * The platforms a person can give ids for, each with its preset: PUT /campaigns/:id/platforms/:key
 * takes `schema` and hands `toSetup`'s result to the setup service. `fromProvisioned` is the same
 * convention applied to ids provisioning obtained, so a provisioned link and a hand-set one look
 * alike.
 */
export const PLATFORM_PRESETS = {
  zeus: { schema: zeusPresetSchema, toSetup: zeusSetup, fromProvisioned: zeusProvisionedSetup },
  nexd: { schema: nexdPresetSchema, toSetup: nexdSetup, fromProvisioned: nexdProvisionedSetup },
} as const
export type PresetPlatform = keyof typeof PLATFORM_PRESETS

export function isPresetPlatform(source: string): source is PresetPlatform {
  return Object.hasOwn(PLATFORM_PRESETS, source)
}

/**
 * Whose numbers are a campaign's headline when nobody chose: the first of these it has ids for,
 * and Zeus while it has none yet (a campaign arriving from Salesforce has no platform ids).
 */
export const HEADLINE_ORDER = ['zeus', 'nexd'] as const

export function headlineSource(sources: readonly string[]): string {
  return (
    HEADLINE_ORDER.find((source) => sources.includes(source)) ?? sources[0] ?? HEADLINE_ORDER[0]
  )
}
