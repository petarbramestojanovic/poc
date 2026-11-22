import { describe, expect, it } from 'vitest'
import {
  campaignIdentities,
  matchDeviceRow,
  resolveTrackerRow,
  ZEUS_PIXEL_ROLE_BY_CODE,
  type CampaignIdentity,
} from '../../../src/modules/sync/connectors/zeus/match.ts'
import type { LinkEntity } from '../../../src/modules/sync/types.ts'

// Which of a link's entities a row of Zeus's two account-wide reports belongs to. Both reports
// are downloaded unfiltered, so every rule here is also a rule about whose rows we must NOT take.

const entity = (
  level: LinkEntity['level'],
  externalId: string,
  over: Partial<LinkEntity> = {},
): LinkEntity => ({ level, externalId, role: null, label: null, campaignTag: '', ...over })

const CAMPAIGN = entity('campaign', 'SF-006A_nexd-77')
const CREATIVE = entity('creative', 'SF-006A_nexd-77_nexd-901', { campaignTag: 'creative-901' })
const OTHER_CREATIVE = entity('creative', 'SF-006A_nexd-77_nexd-902', {
  campaignTag: 'creative-902',
})
const LINK = [CAMPAIGN, CREATIVE, OTHER_CREATIVE]
/** Zeus campaign 501 is ours, and ATK set our string as its external id. */
const OURS: CampaignIdentity[] = [{ zeusId: '501', reportedId: CAMPAIGN.externalId }]

const device = (over: { campaign_id?: string; external_id?: string | null } = {}) => ({
  campaign_id: '501',
  external_id: CAMPAIGN.externalId,
  ...over,
})

const pixel = (
  over: { pixel_id?: string; external_id?: string | null; code?: string | null } = {},
) => ({ pixel_id: '9001', external_id: '9001', code: 'eng', ...over })

describe('campaignIdentities', () => {
  it('reads how the campaign’s own report names it: Zeus’s number and the id it goes by', () => {
    expect(
      campaignIdentities([
        { campaign_id: '501', external_id: 'SF-006A_nexd-77' },
        { campaign_id: '501', external_id: 'SF-006A_nexd-77' },
      ]),
    ).toEqual([{ zeusId: '501', reportedId: 'SF-006A_nexd-77' }])
  })

  it('takes Zeus’s number for the id of a campaign nobody gave an external id', () => {
    for (const external_id of ['91', null, undefined, '']) {
      expect(campaignIdentities([{ campaign_id: '91', external_id }])).toEqual([
        { zeusId: '91', reportedId: '91' },
      ])
    }
  })

  it('knows nothing about a campaign whose report is empty', () => {
    expect(campaignIdentities([])).toEqual([])
  })
})

describe('matchDeviceRow', () => {
  it('puts a row whose external id is a creative’s on that creative', () => {
    const row = device({ external_id: CREATIVE.externalId })
    expect(matchDeviceRow(row, LINK, OURS)).toEqual({ kind: 'owned', entity: CREATIVE })
  })

  it('puts the campaign’s own row on the campaign', () => {
    expect(matchDeviceRow(device(), LINK, OURS)).toEqual({ kind: 'owned', entity: CAMPAIGN })
  })

  it('knows a hand-linked campaign by Zeus’s number when it has no external id', () => {
    const byNumber = [entity('campaign', '91')]
    const row = device({ campaign_id: '91', external_id: '91' })
    expect(matchDeviceRow(row, byNumber, [{ zeusId: '91', reportedId: '91' }])).toEqual({
      kind: 'owned',
      entity: byNumber[0],
    })
  })

  it('does not take a creative of our campaign that the link does not list for the campaign', () => {
    // Zeus names a creative on the row, inside our campaign 501, and the link has no such
    // creative. Counting it on the campaign's own row would add it to the campaign's total.
    const row = device({ external_id: 'SF-006A_nexd-77_nexd-999' })
    expect(matchDeviceRow(row, LINK, OURS)).toEqual({
      kind: 'unlinked',
      owner: 'SF-006A_nexd-77_nexd-999',
    })
    // The same on a link that names its campaign by Zeus's number.
    const byNumber = [entity('campaign', '91'), CREATIVE]
    expect(
      matchDeviceRow(device({ campaign_id: '91', external_id: 'KW46 V2' }), byNumber, [
        { zeusId: '91', reportedId: '91' },
      ]),
    ).toEqual({ kind: 'unlinked', owner: 'KW46 V2' })
  })

  it('needs both of the campaign’s ids: a stranger that shares one of them is not ours', () => {
    // Another Zeus campaign whose external id happens to be our campaign's number.
    const byNumber = [entity('campaign', '91')]
    const identity = [{ zeusId: '91', reportedId: '91' }]
    expect(
      matchDeviceRow(device({ campaign_id: '777', external_id: '91' }), byNumber, identity),
    ).toEqual({ kind: 'not_ours' })
    expect(
      matchDeviceRow(device({ campaign_id: '777', external_id: CAMPAIGN.externalId }), LINK, OURS),
    ).toEqual({ kind: 'not_ours' })
  })

  it('takes nothing for a campaign its own report has no row for', () => {
    expect(matchDeviceRow(device(), LINK, [])).toEqual({ kind: 'not_ours' })
    // A creative is still named by its id alone.
    expect(matchDeviceRow(device({ external_id: CREATIVE.externalId }), LINK, [])).toEqual({
      kind: 'owned',
      entity: CREATIVE,
    })
  })

  it('never takes Zeus’s own number, repeated where no external id is set, for a creative’s id', () => {
    const numbered = entity('creative', '501', { campaignTag: 'c' })
    expect(
      matchDeviceRow(device({ campaign_id: '501', external_id: '501' }), [numbered], []),
    ).toEqual({ kind: 'not_ours' })
    // The same string as a real external id does name it.
    expect(
      matchDeviceRow(device({ campaign_id: '9', external_id: '501' }), [numbered], []),
    ).toEqual({ kind: 'owned', entity: numbered })
  })

  it('has only its creatives on a link without a campaign id, and never counts for a pixel', () => {
    expect(matchDeviceRow(device(), [CREATIVE], OURS)).toEqual({ kind: 'not_ours' })
    const handMapped = entity('pixel', 'px-1', { role: 'engagement' })
    expect(matchDeviceRow(device({ external_id: 'px-1' }), [handMapped], [])).toEqual({
      kind: 'not_ours',
    })
  })
})

describe('resolveTrackerRow', () => {
  it('knows what `eng` counts', () => {
    expect([...ZEUS_PIXEL_ROLE_BY_CODE]).toEqual([['eng', 'engagement']])
  })

  it('counts an `eng` pixel that carries a creative’s id as that creative’s engagement', () => {
    const row = pixel({ external_id: CREATIVE.externalId })
    expect(resolveTrackerRow(row, LINK)).toEqual({
      kind: 'counted',
      entity: CREATIVE,
      role: 'engagement',
    })
  })

  it('names creatives only: a pixel that carries the campaign’s id is not counted by the rule', () => {
    // On a divided campaign its fires would land on the campaign's own row, beside the
    // creatives' and added to them by every campaign-level read.
    const row = pixel({ external_id: CAMPAIGN.externalId })
    expect(resolveTrackerRow(row, LINK)).toEqual({ kind: 'not_ours' })
  })

  it('never takes a pixel’s own number, repeated where no external id is set, for a creative’s id', () => {
    const numbered = entity('creative', '9001', { campaignTag: 'c' })
    expect(resolveTrackerRow(pixel(), [numbered])).toEqual({ kind: 'not_ours' })
  })

  it.each([
    ['fin', 'pixel 9001 with code "fin" on SF-006A_nexd-77_nexd-901'],
    ['ENG', 'pixel 9001 with code "ENG" on SF-006A_nexd-77_nexd-901'],
    [null, 'pixel 9001 with no code on SF-006A_nexd-77_nexd-901'],
    ['', 'pixel 9001 with no code on SF-006A_nexd-77_nexd-901'],
  ])(
    'queues a pixel on our creative whose code %j has no role, and guesses nothing',
    (code, label) => {
      const row = pixel({ external_id: CREATIVE.externalId, code })
      expect(resolveTrackerRow(row, LINK)).toEqual({ kind: 'unmapped', label })
    },
  )

  it('ignores another campaign’s pixel, whatever its code', () => {
    const row = pixel({ external_id: 'SF-006B_nexd-88_nexd-1', code: 'eng' })
    expect(resolveTrackerRow(row, LINK)).toEqual({ kind: 'not_ours' })
  })

  describe('a pixel a person mapped by hand', () => {
    const finish = entity('pixel', '9002', { role: 'finish', campaignTag: 'creative-901' })

    it('is named by Zeus’s pixel number and counts what the person said', () => {
      const row = pixel({ pixel_id: '9002', external_id: 'anything', code: 'whatever' })
      expect(resolveTrackerRow(row, [...LINK, finish])).toEqual({
        kind: 'counted',
        entity: finish,
        role: 'finish',
      })
    })

    it('is never named by its code, its name’s neighbour the external id, or anything shared', () => {
      // `eng` is on every campaign's pixel, and an external id is shared by the pixels of one
      // creative: neither says which pixel a person meant.
      const calledEng = entity('pixel', 'eng', { role: 'engagement' })
      const calledByExternalId = entity('pixel', 'shared-id', { role: 'engagement' })
      const row = pixel({ pixel_id: '5', external_id: 'shared-id', code: 'eng' })
      expect(resolveTrackerRow(row, [calledEng, calledByExternalId])).toEqual({ kind: 'not_ours' })
    })

    it('claims that one pixel only, not the others that carry the same external id', () => {
      // Two pixels of one creative the link does not list: only 9002 was mapped.
      const eng = pixel({ pixel_id: '9001', external_id: 'KW45 V1', code: 'eng' })
      const fin = pixel({ pixel_id: '9002', external_id: 'KW45 V1', code: 'fin' })
      expect(resolveTrackerRow(eng, [CAMPAIGN, finish])).toEqual({ kind: 'not_ours' })
      expect(resolveTrackerRow(fin, [CAMPAIGN, finish])).toMatchObject({
        kind: 'counted',
        role: 'finish',
      })
    })

    it('is the way to count a pixel on our creative whose code has no role yet', () => {
      // The creative's finish pixel carries the creative's id and a code nobody agreed on.
      const fin = pixel({ pixel_id: '9002', external_id: CREATIVE.externalId, code: 'fin' })
      expect(resolveTrackerRow(fin, LINK)).toMatchObject({ kind: 'unmapped' })
      expect(resolveTrackerRow(fin, [...LINK, finish])).toEqual({
        kind: 'counted',
        entity: finish,
        role: 'finish',
      })
      // The engagement pixel beside it still counts by the rule.
      const eng = pixel({ pixel_id: '9001', external_id: CREATIVE.externalId, code: 'eng' })
      expect(resolveTrackerRow(eng, [...LINK, finish])).toEqual({
        kind: 'counted',
        entity: CREATIVE,
        role: 'engagement',
      })
    })

    it('wins over the rule: what a person said about one pixel stands', () => {
      const asFinish = entity('pixel', '9001', { role: 'finish', campaignTag: 'creative-901' })
      const row = pixel({ pixel_id: '9001', external_id: CREATIVE.externalId, code: 'eng' })
      expect(resolveTrackerRow(row, [...LINK, asFinish])).toEqual({
        kind: 'counted',
        entity: asFinish,
        role: 'finish',
      })
    })

    it('with a role nobody knows is queued, not counted as something else', () => {
      const odd = entity('pixel', '7', { role: 'view' })
      const row = pixel({ pixel_id: '7', external_id: '7', code: 'eng' })
      expect(resolveTrackerRow(row, [odd])).toEqual({
        kind: 'unmapped',
        label: 'pixel 7 mapped by hand with role "view"',
      })
    })
  })
})
