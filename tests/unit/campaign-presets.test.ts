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

  it('tags a creative with its own id by default', () => {
    const setup = zeusSetup(
      zeusPresetSchema.parse({
        campaignId: '18',
        idType: 'external_id',
        creatives: [{ id: 501, label: 'MPU V1' }],
      }),
    )
    expect(setup.entities[1]).toEqual({
      level: 'creative',
      externalId: '501',
      label: 'MPU V1',
      campaignTag: '501',
    })
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
  it('sets up one creative entity per live id, tagged with it', () => {
    const setup = nexdSetup(
      nexdPresetSchema.parse({ creatives: [{ liveId: 'nx_1', label: 'V1' }, { liveId: 'nx_2' }] }),
    )

    expect(setup.entities).toEqual([
      { level: 'creative', externalId: 'nx_1', label: 'V1', campaignTag: 'nx_1' },
      { level: 'creative', externalId: 'nx_2', campaignTag: 'nx_2' },
    ])
    expect(setup.config).toEqual({})
  })

  it('maps the two events that mean the same in every creative, and only those', () => {
    const setup = nexdSetup(nexdPresetSchema.parse({ creatives: [{ liveId: 'nx_1' }] }))
    expect(setup.eventMap).toEqual([
      { eventName: 'Unique [Touch]', targetKind: 'metric', targetId: 'interactions' },
      { eventName: 'Unique [Hover]', targetKind: 'metric', targetId: 'hovered' },
    ])
  })

  it('needs at least one creative', () => {
    expect(nexdPresetSchema.safeParse({ creatives: [] }).success).toBe(false)
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
      PLATFORM_PRESETS.nexd.schema.parse({ creatives: [{ liveId: 'nx_1' }] }),
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
