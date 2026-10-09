import { describe, expect, it } from 'vitest'
import { InvalidSetupError, UnsupportedSourceError } from '../../src/modules/campaigns/errors.ts'
import { sourceSetupSchema, type SourceSetup } from '../../src/modules/campaigns/input.ts'
import {
  nexdPresetSchema,
  nexdSetup,
  zeusPresetSchema,
  zeusSetup,
} from '../../src/modules/campaigns/presets.ts'
import { checkSources } from '../../src/modules/campaigns/validate.ts'
import { createDefaultRegistry } from '../../src/modules/sync/connectors/index.ts'
import { InvalidLinkConfigError } from '../../src/modules/sync/errors.ts'
import { at } from '../helpers.ts'

// A setup is checked against what the REAL connectors declare, so a link the engine would refuse
// at 04:00 is refused when it is typed in. No database is involved.

const registry = createDefaultRegistry()

const source = (over: Record<string, unknown>): SourceSetup =>
  sourceSetupSchema.parse({
    source: 'zeus',
    config: { clickthrough_cta_id: 'clickthrough' },
    entities: [{ level: 'campaign', externalId: '18' }],
    ...over,
  })

describe('checkSources', () => {
  it('accepts what the presets produce', () => {
    const zeus = zeusSetup(
      zeusPresetSchema.parse({
        campaignId: '18',
        idType: 'internal_id',
        pixels: [{ code: 'abc', role: 'engagement' }],
      }),
    )
    const nexd = nexdSetup(nexdPresetSchema.parse({ creatives: [{ liveId: 'nx_1' }] }))

    expect(checkSources(registry, [zeus, nexd]).map((s) => s.source)).toEqual(['zeus', 'nexd'])
  })

  it('returns the config as the connector parsed it, defaults included', () => {
    const checked = at(checkSources(registry, [source({})]))
    expect(checked.config).toEqual({
      clickthrough_cta_id: 'clickthrough',
      campaign_id_param: 'external_id',
    })
  })

  it('refuses a source without a connector', () => {
    expect(() => checkSources(registry, [source({ source: 'adnuntius' })])).toThrow(
      UnsupportedSourceError,
    )
  })

  it('refuses an entity level the connector does not read', () => {
    // NEXD reads creatives only; a campaign-level id would simply never be synced.
    const nexd = source({
      source: 'nexd',
      config: {},
      entities: [{ level: 'campaign', externalId: 'x' }],
    })
    expect(() => checkSources(registry, [nexd])).toThrow(/does not accept 'campaign'/)
  })

  it('refuses a pixel without one of the roles the connector knows', () => {
    const missing = source({ entities: [{ level: 'pixel', externalId: 'abc' }] })
    const unknown = source({ entities: [{ level: 'pixel', externalId: 'abc', role: 'view' }] })

    expect(() => checkSources(registry, [missing])).toThrow(/engagement or finish/)
    expect(() => checkSources(registry, [unknown])).toThrow(InvalidSetupError)
  })

  it('refuses a role on a level that has none', () => {
    const creative = source({
      entities: [{ level: 'creative', externalId: '501', role: 'finish' }],
    })
    expect(() => checkSources(registry, [creative])).toThrow(/take no role/)
  })

  it('refuses the same platform id twice in one setup', () => {
    const twice = source({
      entities: [
        { level: 'campaign', externalId: '18' },
        { level: 'campaign', externalId: '18' },
      ],
    })
    expect(() => checkSources(registry, [twice])).toThrow(/listed twice/)
  })

  it('refuses two setups for the same source and language', () => {
    expect(() => checkSources(registry, [source({}), source({})])).toThrow(/set up twice/)
    // Another language is another link.
    expect(checkSources(registry, [source({}), source({ language: 'fr' })])).toHaveLength(2)
  })

  it('refuses a config the connector would reject, naming the field and not the value', () => {
    const bad = source({ config: { campaign_id_param: 'sk-live-not-a-valid-choice' } })

    let error: unknown
    try {
      checkSources(registry, [bad])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(InvalidLinkConfigError)
    const issues = (error as InvalidLinkConfigError).issues.map((issue) => issue.path)
    expect(issues).toContain('clickthrough_cta_id')
    expect((error as Error).message).not.toContain('sk-live-not-a-valid-choice')
  })
})
