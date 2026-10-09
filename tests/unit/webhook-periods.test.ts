import { describe, expect, it } from 'vitest'
import { reportPeriod } from '../../src/modules/webhooks/periods.ts'

// The period is always one that has ENDED in the webhook's own timezone. An instant is never a
// day: the same moment is a different calendar day in Zurich and in Auckland, and the report
// window follows the webhook, not the server.

describe('reportPeriod', () => {
  it('reports the previous day', () => {
    // Monday 08:00 Zurich.
    expect(reportPeriod('previous_day', 'Europe/Zurich', new Date('2026-09-14T06:00:00Z'))).toEqual(
      { from: '2026-09-13', to: '2026-09-13' },
    )
  })

  it('reports the previous Monday-to-Sunday week', () => {
    expect(
      reportPeriod('previous_week', 'Europe/Zurich', new Date('2026-09-14T06:00:00Z')),
    ).toEqual({ from: '2026-09-07', to: '2026-09-13' })
  })

  it('reports the week that just closed when the schedule fires on a Sunday', () => {
    // Sunday 2026-09-13 is the last day of the week we would report on Monday; from Sunday the
    // completed week is the one before it.
    expect(
      reportPeriod('previous_week', 'Europe/Zurich', new Date('2026-09-13T06:00:00Z')),
    ).toEqual({ from: '2026-08-31', to: '2026-09-06' })
  })

  it('reports the previous calendar month', () => {
    expect(
      reportPeriod('previous_month', 'Europe/Zurich', new Date('2026-09-01T06:00:00Z')),
    ).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('crosses the year boundary', () => {
    expect(
      reportPeriod('previous_month', 'Europe/Zurich', new Date('2027-01-05T06:00:00Z')),
    ).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('handles February in a leap year', () => {
    expect(reportPeriod('previous_month', 'UTC', new Date('2028-03-02T00:00:00Z'))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    })
  })

  it('resolves the day in the webhook timezone, not the server one', () => {
    // 23:30 UTC on the 13th is already the 14th in Auckland, so the previous day differs.
    const instant = new Date('2026-09-13T23:30:00Z')
    expect(reportPeriod('previous_day', 'UTC', instant)).toEqual({
      from: '2026-09-12',
      to: '2026-09-12',
    })
    expect(reportPeriod('previous_day', 'Pacific/Auckland', instant)).toEqual({
      from: '2026-09-13',
      to: '2026-09-13',
    })
  })
})
