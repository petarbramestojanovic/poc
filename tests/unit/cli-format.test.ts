import { describe, expect, it } from 'vitest'
import { formatNightlyPass, formatPixels, formatSyncSummary } from '../../src/cli/sync-commands.ts'
import type { NightlyCandidate } from '../../src/modules/sync/repo.ts'

const base = {
  syncRunId: 'run-1',
  daysWritten: 7,
  rowsWritten: 14,
  rowsDeleted: 12,
  httpCalls: 3,
  durationMs: 1840,
}

describe('CLI output', () => {
  it('summarises a real run', () => {
    const text = formatSyncSummary({ ...base, dryRun: false, warnings: ['window clamped'] })
    expect(text).toContain('Sync run-1 succeeded in 1.8 s.')
    expect(text).toContain('days written   7')
    expect(text).toContain('rows written   14 (replaced 12)')
    expect(text).toContain('warning: window clamped')
  })

  it('shows only what a dry run would change, with unmeasured values as a dash', () => {
    const text = formatSyncSummary({
      ...base,
      dryRun: true,
      warnings: [],
      diff: [
        {
          date: '2026-09-01',
          rows: { before: 1, after: 1 },
          metrics: {
            impressions: { before: 1000, after: 1500 },
            in_view: { before: 800, after: 800 },
            game_finished: { before: 20, after: null },
          },
          perTag: {
            unique_impressions_reported: [{ campaignTag: 'mpu_v1', before: 900, after: 950 }],
          },
          pageViews: { before: 0, after: 0 },
          ctaClicks: { before: 10, after: 12 },
        },
        {
          date: '2026-09-02',
          rows: { before: 1, after: 1 },
          metrics: {},
          perTag: {},
          pageViews: { before: 0, after: 0 },
          ctaClicks: { before: 0, after: 0 },
        },
      ],
    })
    expect(text).toContain('Dry run run-1: nothing was written')
    expect(text).toContain(
      '2026-09-01  impressions 1000 -> 1500, game_finished 20 -> -, unique_impressions_reported[mpu_v1] 900 -> 950, cta clicks 10 -> 12',
    )
    expect(text).not.toContain('in_view')
    expect(text).toContain('2026-09-02  no change')
  })

  it('lists every link of a nightly pass with its outcome', () => {
    const window = { from: '2026-09-03', to: '2026-09-09' }
    const finished: NightlyCandidate = {
      linkId: 'l3',
      sourceId: 'nexd',
      credentialId: 'c1',
      campaignId: 'k1',
      campaignName: 'Old campaign',
      campaignStatus: 'active',
      startsOn: '2026-01-01',
      endsOn: '2026-02-01',
      source: { id: 'nexd', dayTimezone: 'UTC', lookbackDays: 7, deepLookbackDays: 35 },
    }
    const text = formatNightlyPass({
      deep: true,
      durationMs: 12_400,
      results: [
        {
          linkId: 'l1',
          sourceId: 'zeus',
          campaignName: 'Tchibo',
          window,
          outcome: {
            status: 'succeeded',
            syncRunId: 'r1',
            daysWritten: 7,
            rowsWritten: 14,
            warnings: 0,
          },
        },
        {
          linkId: 'l2',
          sourceId: 'nexd',
          campaignName: 'Tchibo',
          window,
          outcome: {
            status: 'failed',
            code: 'credential_unavailable',
            retryable: false,
            message: 'NEXD_API_KEY is not set',
          },
        },
      ],
      skipped: [{ candidate: finished, reason: 'campaign_finished' }],
    })
    expect(text).toContain(
      'Nightly pass (deep pull): 1 synced, 1 failed, 0 not run, 1 skipped, in 12.4 s.',
    )
    expect(text).toMatch(
      /ok\s+zeus\s+l1\s+2026-09-03\.\.2026-09-09\s+Tchibo\s+7 days, 14 rows, run r1/,
    )
    expect(text).toMatch(/FAILED\s+nexd\s+l2 .*\[credential_unavailable\] NEXD_API_KEY is not set/)
    expect(text).toMatch(/skipped\s+nexd\s+l3\s+campaign_finished\s+Old campaign/)
  })

  it('aligns the pixel table', () => {
    const text = formatPixels([
      {
        pixel_id: '9001',
        external_id: '1823ca',
        code: 'dev1eng',
        name: 'Engagement',
        fires_last_7_days: 1860,
      },
      { pixel_id: '12', external_id: null, code: null, name: 'Finish', fires_last_7_days: 900 },
    ])
    const [header, first, second] = text.split('\n')
    expect(header).toMatch(/^pixel_id\s+external_id\s+code\s+name\s+fires \(7 days\)$/)
    expect(first).toMatch(/^9001\s+1823ca\s+dev1eng\s+Engagement\s+1860$/)
    expect(second?.indexOf('Finish')).toBe(first?.indexOf('Engagement'))
    expect(formatPixels([])).toBe('No pixels fired in the last 7 days.')
  })
})
