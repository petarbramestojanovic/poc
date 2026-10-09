import { describe, expect, it } from 'vitest'
import { completeDays, lookbackWindow } from '../../src/modules/sync/windows.ts'

const utcSource = { id: 'zeus', dayTimezone: 'UTC', lookbackDays: 7, deepLookbackDays: 35 }
const THURSDAY = new Date('2026-09-10T02:00:00Z')

describe('lookbackWindow', () => {
  it('ends at yesterday and spans the lookback', () => {
    expect(lookbackWindow(utcSource, { deep: false, now: THURSDAY })).toEqual({
      from: '2026-09-03',
      to: '2026-09-09',
    })
  })

  it('spans the deep lookback when asked', () => {
    expect(lookbackWindow(utcSource, { deep: true, now: THURSDAY })).toEqual({
      from: '2026-08-06',
      to: '2026-09-09',
    })
  })

  it("uses the source's day zone, not the server clock, near midnight", () => {
    const now = new Date('2026-09-11T23:30:00Z') // 01:30 on the 12th in Zurich
    expect(lookbackWindow(utcSource, { deep: false, now }).to).toBe('2026-09-10')
    const zurich = { ...utcSource, dayTimezone: 'Europe/Zurich' }
    expect(lookbackWindow(zurich, { deep: false, now }).to).toBe('2026-09-11')
  })

  it('refuses a source without a lookback', () => {
    const own = { id: 'brame', dayTimezone: 'Europe/Zurich', lookbackDays: 0, deepLookbackDays: 0 }
    expect(() => lookbackWindow(own, { deep: false, now: THURSDAY })).toThrow(
      'brame has no lookback',
    )
  })
})

describe('completeDays', () => {
  const window = { from: '2026-09-01', to: '2026-09-05' }

  it('keeps a window that ends before today', () => {
    expect(completeDays(window, utcSource, new Date('2026-09-06T00:00:00Z'))).toBe(window)
  })

  it('cuts a window that reaches today or later at yesterday', () => {
    expect(completeDays(window, utcSource, new Date('2026-09-05T23:59:59Z'))).toEqual({
      from: '2026-09-01',
      to: '2026-09-04',
    })
    expect(completeDays({ from: '2026-09-01', to: '2026-12-31' }, utcSource, THURSDAY)).toEqual({
      from: '2026-09-01',
      to: '2026-09-09',
    })
  })

  it('has nothing when the window starts today or later', () => {
    expect(completeDays({ from: '2026-09-10', to: '2026-09-12' }, utcSource, THURSDAY)).toBeNull()
  })

  it("judges today in the source's day zone", () => {
    // 23:30 UTC on 09-05 is already 09-06 on Kiritimati (UTC+14): 09-05 is complete there.
    const now = new Date('2026-09-05T23:30:00Z')
    expect(completeDays(window, utcSource, now)?.to).toBe('2026-09-04')
    expect(completeDays(window, { dayTimezone: 'Pacific/Kiritimati' }, now)?.to).toBe('2026-09-05')
  })
})
