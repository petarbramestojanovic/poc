import { z } from 'zod'
import { sourceSetupSchema, type SourceSetup } from './input.ts'

// Shortcuts from "the ids a person has at hand" to a full SourceSetup. The setup service itself is
// platform-neutral; everything a platform needs by convention — the CTA Zeus clicks are written
// to, the two NEXD events that mean the same thing in every creative — is decided here, once, so
// the console form and a future CRM adapter set a campaign up identically.
//
// A new platform is one schema and one function in this file, plus its key in platformSources.

const id = z.union([z.string(), z.number()]).transform((value) => String(value).trim())
const nonEmptyId = id.refine((value) => value.length > 0 && value.length <= 255, {
  error: 'must not be empty',
})
const label = z.string().trim().min(1).max(200).optional()
const tag = z.string().trim().max(200).optional()
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
  /** Optional per-creative breakdown. A creative's tag defaults to its id. */
  creatives: z.array(z.strictObject({ id: nonEmptyId, label, tag })).default([]),
  ...linkFields,
})
export type ZeusPreset = z.infer<typeof zeusPresetSchema>

export function zeusSetup(input: ZeusPreset): SourceSetup {
  return sourceSetupSchema.parse({
    source: 'zeus',
    language: input.language ?? '',
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    config: { clickthrough_cta_id: CLICKTHROUGH_CTA.ctaId, campaign_id_param: input.idType },
    entities: [
      { level: 'campaign', externalId: input.campaignId },
      ...input.creatives.map((creative) => ({
        level: 'creative',
        externalId: creative.id,
        ...(creative.label === undefined ? {} : { label: creative.label }),
        campaignTag: creative.tag ?? creative.id,
      })),
      ...input.pixels.map((pixel) => ({
        level: 'pixel',
        externalId: pixel.code,
        role: pixel.role,
        ...(pixel.label === undefined ? {} : { label: pixel.label }),
        campaignTag: pixel.tag ?? '',
      })),
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
  /** One entry per NEXD creative (live id). A creative's tag defaults to its live id. */
  creatives: z.array(z.strictObject({ liveId: nonEmptyId, label, tag })).min(1),
  ...linkFields,
})
export type NexdPreset = z.infer<typeof nexdPresetSchema>

export function nexdSetup(input: NexdPreset): SourceSetup {
  return sourceSetupSchema.parse({
    source: 'nexd',
    language: input.language ?? '',
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    entities: input.creatives.map((creative) => ({
      level: 'creative',
      externalId: creative.liveId,
      ...(creative.label === undefined ? {} : { label: creative.label }),
      campaignTag: creative.tag ?? creative.liveId,
    })),
    // 'Page seen [...]' and 'CTR [...]' are named per creative, so they are not guessed here:
    // they arrive in external.unmapped_event and are mapped once someone has seen them.
    eventMap: [...NEXD_STANDARD_EVENTS],
  })
}

/** The `sources` object of a setup request: one optional block per platform. */
export const platformSourcesSchema = z.strictObject({
  zeus: zeusPresetSchema.optional(),
  nexd: nexdPresetSchema.optional(),
})
export type PlatformSources = z.infer<typeof platformSourcesSchema>

export function toSourceSetups(sources: PlatformSources): SourceSetup[] {
  return [
    ...(sources.zeus ? [zeusSetup(sources.zeus)] : []),
    ...(sources.nexd ? [nexdSetup(sources.nexd)] : []),
  ]
}
