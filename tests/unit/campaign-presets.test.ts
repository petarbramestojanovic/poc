import { describe, expect, it } from 'vitest'
import {
  headlineSource,
  nexdPresetSchema,
  nexdSetup,
  PLATFORM_PRESETS,
  zeusPresetSchema,
  zeusSetup,
} from '../../src/modules/campaigns/presets.ts'

// The presets turn "the ids a person has" into a complete platform-neutral SourceSetup. What they
// add by convention is pinned here.

describe('zeus preset', () => {
  it('turns a campaign id into a syncable link setup', () => {
    const setup = zeusSetup(zeusPresetSchema.parse({ campaignId: 18, idType: 'internal_id' }))

    expect(setup).toMatchObject({
      source: 'zeus',
      language: '',
      config: { clickthrough_cta_id: 'clickthrough', campaign_id_param: 'internal_id' },
      entities: [{ level: 'campaign', externalId: '18', campaignTag: '' }],
      // The CTA the config points at is part of the setup, so the link can write clicks at once.
      ctas: [{ ctaId: 'clickthrough', name: 'Click-out' }],
      eventMap: [],
    })
  })

  it('adds pixels with their role, on the campaign row unless a tag says otherwise', () => {
    const setup = zeusSetup(
      zeusPresetSchema.parse({
        campaignId: '18',
        idType: 'internal_id',
        pixels: [
          { code: 'abc123', role: 'engagement' },
          { code: 'def456', role: 'finish', tag: 'mpu_v1' },
        ],
      }),
    )

    expect(setup.entities.slice(1)).toEqual([
      { level: 'pixel', externalId: 'abc123', role: 'engagement', campaignTag: '' },
      { level: 'pixel', externalId: 'def456', role: 'finish', campaignTag: 'mpu_v1' },
    ])
  })

  it('leaves a creative untagged for the service to make it one of ours, unless a tag names one', () => {
    const setup = zeusSetup(
      zeusPresetSchema.parse({
        campaignId: '18',
        idType: 'external_id',
        creatives: [
          { id: 501, label: 'MPU V1', type: 'Swipe Card' },
          { id: 502, tag: 'nx_1' },
        ],
      }),
    )
    // No tag and no platform id in sight: the setup service tags the new creative with its own id.
    expect(setup.entities[1]).toEqual({
      level: 'creative',
      externalId: '501',
      label: 'MPU V1',
      creativeType: 'Swipe Card',
    })
    // A tag says which creative of the campaign this Zeus id is (the same one NEXD knows as nx_1).
    expect(setup.entities[2]).toEqual({ level: 'creative', externalId: '502', campaignTag: 'nx_1' })
  })

  it('never guesses which of the two Zeus ids was meant', () => {
    // The wrong one returns another campaign's rows, or nothing: the caller has to say.
    expect(zeusPresetSchema.safeParse({ campaignId: '18' }).success).toBe(false)
  })

  it.each([
    ['an empty campaign id', { campaignId: '  ', idType: 'internal_id' }],
    [
      'an unknown pixel role',
      { campaignId: '18', idType: 'internal_id', pixels: [{ code: 'x', role: 'view' }] },
    ],
    ['an unknown field', { campaignId: '18', idType: 'internal_id', pixel: 'x' }],
  ])('refuses %s', (_name, input) => {
    expect(zeusPresetSchema.safeParse(input).success).toBe(false)
  })
})

describe('nexd preset', () => {
  it('sets up one creative entity per live id, each a creative of ours unless a tag names one', () => {
    const setup = nexdSetup(
      nexdPresetSchema.parse({
        creatives: [
          { liveId: 'nx_1', label: 'V1' },
          { liveId: 'nx_2', label: 'V2', tag: 'mpu_v1', type: 'Reveal Ad' },
        ],
      }),
    )

    // The live id is never the tag any more: no platform id enters an analytics row.
    expect(setup.entities).toEqual([
      { level: 'creative', externalId: 'nx_1', label: 'V1' },
      {
        level: 'creative',
        externalId: 'nx_2',
        label: 'V2',
        campaignTag: 'mpu_v1',
        creativeType: 'Reveal Ad',
      },
    ])
    expect(setup.config).toEqual({})
  })

  it('needs a label for every creative: it is the name a client sees, and NEXD gives none', () => {
    const without = nexdPresetSchema.safeParse({ creatives: [{ liveId: 'nx_1' }] })
    const blank = nexdPresetSchema.safeParse({ creatives: [{ liveId: 'nx_1', label: '  ' }] })
    expect(without.success).toBe(false)
    expect(blank.success).toBe(false)
    expect(without.success || without.error.issues[0]?.path).toEqual(['creatives', 0, 'label'])
  })

  it('maps the two events that mean the same in every creative, and only those', () => {
    const setup = nexdSetup(
      nexdPresetSchema.parse({ creatives: [{ liveId: 'nx_1', label: 'V1' }] }),
    )
    expect(setup.eventMap).toEqual([
      { eventName: 'Unique [Touch]', targetKind: 'metric', targetId: 'interactions' },
      { eventName: 'Unique [Hover]', targetKind: 'metric', targetId: 'hovered' },
    ])
  })

  it('names the NEXD campaign as a campaign-level id, so provisioning adds creatives to it', () => {
    const setup = nexdSetup(nexdPresetSchema.parse({ campaignId: 'coYV5VGFPODsDnKi' }))
    expect(setup.entities).toEqual([
      { level: 'campaign', externalId: 'coYV5VGFPODsDnKi', campaignTag: '' },
    ])
  })

  it('needs the NEXD campaign, a creative, or both', () => {
    expect(nexdPresetSchema.safeParse({}).success).toBe(false)
    expect(nexdPresetSchema.safeParse({ creatives: [] }).success).toBe(false)
    expect(nexdPresetSchema.safeParse({ campaignId: 'c1' }).success).toBe(true)
  })
})

describe('platform presets', () => {
  it('offers one preset per platform a person can give ids for', () => {
    expect(Object.keys(PLATFORM_PRESETS)).toEqual(['zeus', 'nexd'])
    const zeus = PLATFORM_PRESETS.zeus.toSetup(
      PLATFORM_PRESETS.zeus.schema.parse({
        campaignId: '18',
        idType: 'internal_id',
        language: 'de',
      }),
    )
    const nexd = PLATFORM_PRESETS.nexd.toSetup(
      PLATFORM_PRESETS.nexd.schema.parse({ creatives: [{ liveId: 'nx_1', label: 'V1' }] }),
    )
    expect([zeus.source, zeus.language, nexd.source, nexd.language]).toEqual([
      'zeus',
      'de',
      'nexd',
      '',
    ])
  })
})

describe('headline source', () => {
  it.each<[string, string[], string]>([
    ['Zeus while a campaign has no ids yet', [], 'zeus'],
    ['Zeus once it has Zeus ids', ['zeus'], 'zeus'],
    ['Zeus when it has both', ['nexd', 'zeus'], 'zeus'],
    ['NEXD when it has only NEXD ids', ['nexd'], 'nexd'],
    ['a platform outside the order when it is the only one', ['adnuntius'], 'adnuntius'],
  ])('is %s', (_name, sources, expected) => {
    expect(headlineSource(sources)).toBe(expected)
  })
})
