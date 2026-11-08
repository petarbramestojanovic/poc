import { describe, expect, it } from 'vitest'
import { createZeusConnector } from '../../../src/modules/sync/connectors/zeus/connector.ts'
import { deriveZeusExternalIds } from '../../../src/modules/sync/connectors/zeus/handoff.ts'
import { derivesExternalIds, type ExternalIdInput } from '../../../src/modules/sync/types.ts'

// The strings ATK sets as external ids, in the format agreed on 2026-11-03. Pure: derived from
// the CRM reference and the builder's ids, nothing else.

const CREATIVE_A = {
  id: 'a0a0a0a0-0000-4000-8000-000000000001',
  tag: 'a0a0a0a0-0000-4000-8000-000000000001',
  type: 'Swipe Card',
  name: 'Swipe',
}
const CREATIVE_B = {
  id: 'b0b0b0b0-0000-4000-8000-000000000002',
  tag: 'b0b0b0b0-0000-4000-8000-000000000002',
  type: 'Voting Ad',
  name: 'Vote',
}

const input = (over: Partial<ExternalIdInput> = {}): ExternalIdInput => ({
  campaign: {
    id: 'c0c0c0c0-0000-4000-8000-000000000003',
    name: 'DE2611 Tchibo Winter',
    externalRef: { system: 'salesforce', id: '006Rp00000ABCDE' },
  },
  creatives: [CREATIVE_A, CREATIVE_B],
  resources: [
    { source: 'nexd', kind: 'campaign', externalId: 'kb6t7EURIIri1kYa', creativeId: null },
    { source: 'nexd', kind: 'creative', externalId: 'c7f2a1b9', creativeId: CREATIVE_A.id },
    { source: 'nexd', kind: 'publish', externalId: 'pub-1', creativeId: CREATIVE_A.id },
    { source: 'nexd', kind: 'creative', externalId: 'd41e0c22', creativeId: CREATIVE_B.id },
  ],
  ...over,
})

describe('deriveZeusExternalIds', () => {
  it('derives the agreed strings for the campaign and each creative the builder has', () => {
    expect(deriveZeusExternalIds(input())).toEqual([
      {
        level: 'campaign',
        creativeId: null,
        externalId: 'SF-006Rp00000ABCDE_nexd-kb6t7EURIIri1kYa',
      },
      {
        level: 'creative',
        creativeId: CREATIVE_A.id,
        externalId: 'SF-006Rp00000ABCDE_nexd-kb6t7EURIIri1kYa_nexd-c7f2a1b9',
      },
      {
        level: 'creative',
        creativeId: CREATIVE_B.id,
        externalId: 'SF-006Rp00000ABCDE_nexd-kb6t7EURIIri1kYa_nexd-d41e0c22',
      },
    ])
  })

  it('leaves out a creative the builder has not created yet, and grows when it has', () => {
    const before = input({
      resources: [
        { source: 'nexd', kind: 'campaign', externalId: 'kb6t7EURIIri1kYa', creativeId: null },
        { source: 'nexd', kind: 'creative', externalId: 'c7f2a1b9', creativeId: CREATIVE_A.id },
      ],
    })
    expect(deriveZeusExternalIds(before).map((d) => d.creativeId)).toEqual([null, CREATIVE_A.id])
  })

  it('derives nothing without the CRM reference or the builder campaign: never a guess', () => {
    expect(
      deriveZeusExternalIds(input({ campaign: { ...input().campaign, externalRef: null } })),
    ).toEqual([])
    expect(deriveZeusExternalIds(input({ resources: [] }))).toEqual([])
    // Another platform's campaign id is not the builder's.
    expect(
      deriveZeusExternalIds(
        input({
          resources: [{ source: 'other', kind: 'campaign', externalId: 'x', creativeId: null }],
        }),
      ),
    ).toEqual([])
  })

  it('prefixes another CRM with its own name, so two systems cannot collide on an id', () => {
    const derived = deriveZeusExternalIds(
      input({ campaign: { ...input().campaign, externalRef: { system: 'hubspot', id: '42' } } }),
    )
    expect(derived[0]?.externalId).toBe('HUBSPOT-42_nexd-kb6t7EURIIri1kYa')
  })

  it('is a capability the Zeus connector declares', () => {
    const zeus = createZeusConnector()
    expect(derivesExternalIds(zeus)).toBe(true)
    expect(zeus.deriveExternalIds(input())).toHaveLength(3)
  })
})
