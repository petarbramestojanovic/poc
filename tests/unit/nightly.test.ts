import { describe, expect, it } from 'vitest'
import { isDeepPullNight, planNightlyPass } from '../../src/sync/nightly.ts'
import type { NightlyCandidate } from '../../src/sync/repo.ts'

const THURSDAY = new Date('2026-09-10T02:00:00Z') // 04:00 in Zurich
const SUNDAY = new Date('2026-09-13T02:00:00Z') // 04:00 in Zurich

const candidate = (over: Partial<NightlyCandidate> = {}): NightlyCandidate => ({
  linkId: 'link-1',
  sourceId: 'zeus',
  credentialId: 'cred-1',
  campaignId: 'camp-1',
  campaignName: 'Campaign',
  campaignStatus: 'active',
  startsOn: '2026-08-01',
  endsOn: '2026-10-31',
  source: { id: 'zeus', dayTimezone: 'UTC', lookbackDays: 7, deepLookbackDays: 35 },
  ...over,
})

describe('planNightlyPass', () => {
  it('plans an active campaign over the lookback ending yesterday', () => {
    expect(planNightlyPass([candidate()], THURSDAY)).toEqual({
      deep: false,
      planned: [{ candidate: candidate(), window: { from: '2026-09-03', to: '2026-09-09' } }],
      skipped: [],
    })
  })

  it('pulls the deep lookback on Sunday', () => {
    const plan = planNightlyPass([candidate()], SUNDAY)
    expect(plan.deep).toBe(true)
    expect(plan.planned[0]?.window).toEqual({ from: '2026-08-09', to: '2026-09-12' })
  })

  it.each([
    {
      name: 'archived',
      over: { campaignStatus: 'archived' as const },
      reason: 'campaign_archived',
    },
    {
      name: 'starting after the newest complete day',
      over: { startsOn: '2026-09-10' },
      reason: 'campaign_not_started',
    },
    {
      name: 'that ended before the deep lookback begins',
      over: { endsOn: '2026-08-05' },
      reason: 'campaign_finished',
    },
  ])('skips a campaign $name', ({ over, reason }) => {
    const plan = planNightlyPass([candidate(over)], THURSDAY)
    expect(plan.planned).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual([reason])
  })

  it.each([
    { name: 'starting on the newest complete day', over: { startsOn: '2026-09-09' } },
    { name: 'that ended on the first day of the deep lookback', over: { endsOn: '2026-08-06' } },
    { name: 'with unknown dates', over: { startsOn: null, endsOn: null } },
    { name: 'still in draft', over: { campaignStatus: 'draft' as const } },
  ])('keeps a campaign $name', ({ over }) => {
    expect(planNightlyPass([candidate(over)], THURSDAY).planned).toHaveLength(1)
  })
})

describe('isDeepPullNight', () => {
  it('asks whether it is Sunday in Zurich, not in UTC', () => {
    // 00:30 on Sunday in Zurich, still Saturday in UTC.
    expect(isDeepPullNight(new Date('2026-09-12T22:30:00Z'))).toBe(true)
    // 00:30 on Monday in Zurich.
    expect(isDeepPullNight(new Date('2026-09-13T22:30:00Z'))).toBe(false)
  })
})
