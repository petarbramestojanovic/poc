import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CRON,
  FREQUENCIES,
  frequencyOf,
  reportPeriod,
  windowOf,
} from '../../src/modules/webhooks/periods.ts'

// The period is always one that has ENDED in the webhook's own timezone. An instant is never a
// day: the same moment is a different calendar day in Zurich and in Auckland, and the period
// follows the webhook, not the server.

describe('reportPeriod', () => {
  it('reports the previous day', () => {
    // Monday 08:00 Zurich.
    expect(reportPeriod('daily', 'Europe/Zurich', new Date('2026-09-14T06:00:00Z'))).toEqual({
      from: '2026-09-13',
      to: '2026-09-13',
    })
  })

  it('reports the previous Monday-to-Sunday week', () => {
    expect(reportPeriod('weekly', 'Europe/Zurich', new Date('2026-09-14T06:00:00Z'))).toEqual({
      from: '2026-09-07',
      to: '2026-09-13',
    })
  })

  it('reports the week that just closed when the schedule fires on a Sunday', () => {
    // Sunday 2026-09-13 is the last day of the week we would report on Monday; from Sunday the
    // completed week is the one before it.
    expect(reportPeriod('weekly', 'Europe/Zurich', new Date('2026-09-13T06:00:00Z'))).toEqual({
      from: '2026-08-31',
      to: '2026-09-06',
    })
  })

  it('reports the previous calendar month', () => {
    expect(reportPeriod('monthly', 'Europe/Zurich', new Date('2026-09-01T06:00:00Z'))).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    })
  })

  it('crosses the year boundary', () => {
    expect(reportPeriod('monthly', 'Europe/Zurich', new Date('2027-01-05T06:00:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    })
  })

  it('handles February in a leap year', () => {
    expect(reportPeriod('monthly', 'UTC', new Date('2028-03-02T00:00:00Z'))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    })
  })

  it('resolves the day in the webhook timezone, not the server one', () => {
    // 23:30 UTC on the 13th is already the 14th in Auckland, so the previous day differs.
    const instant = new Date('2026-09-13T23:30:00Z')
    expect(reportPeriod('daily', 'UTC', instant)).toEqual({
      from: '2026-09-12',
      to: '2026-09-12',
    })
    expect(reportPeriod('daily', 'Pacific/Auckland', instant)).toEqual({
      from: '2026-09-13',
      to: '2026-09-13',
    })
  })
})

describe('frequencies', () => {
  it('are stored in report_window and read back unchanged', () => {
    expect(FREQUENCIES.map(windowOf)).toEqual(['previous_day', 'previous_week', 'previous_month'])
    for (const frequency of FREQUENCIES) expect(frequencyOf(windowOf(frequency))).toBe(frequency)
  })

  it('refuse a report window the column does not allow', () => {
    expect(() => frequencyOf('previous_year' as never)).toThrow(/unknown report window/)
  })

  it('go out at 05:00 by default, an hour after the nightly sync, on Monday and on the 1st', () => {
    expect(DEFAULT_CRON).toEqual({
      daily: '0 5 * * *',
      weekly: '0 5 * * 1',
      monthly: '0 5 1 * *',
    })
  })
})
