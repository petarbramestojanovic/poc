import { describe, expect, it } from 'vitest'
import {
  addDays,
  assertIsoDate,
  chunkWindow,
  daysInclusive,
  eachDay,
  isConsecutive,
  yesterdayUtc,
} from '../../src/dates.ts'

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(assertIsoDate('2026-02-28')).toBe('2026-02-28')
    expect(() => assertIsoDate('2026-2-8')).toThrow(RangeError)
    expect(() => assertIsoDate('2026-13-01')).toThrow(RangeError)
  })

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('counts and enumerates inclusive windows', () => {
    expect(daysInclusive('2026-09-01', '2026-09-01')).toBe(1)
    expect(daysInclusive('2026-09-01', '2026-09-07')).toBe(7)
    expect(eachDay('2026-09-06', '2026-09-08')).toEqual(['2026-09-06', '2026-09-07', '2026-09-08'])
    expect(() => daysInclusive('2026-09-08', '2026-09-07')).toThrow(RangeError)
  })

  it('chunks a window into at most maxDays pieces', () => {
    const chunks = chunkWindow({ from: '2026-08-01', to: '2026-09-14' }, 21)
    expect(chunks).toEqual([
      { from: '2026-08-01', to: '2026-08-21' },
      { from: '2026-08-22', to: '2026-09-11' },
      { from: '2026-09-12', to: '2026-09-14' },
    ])
    expect(chunkWindow({ from: '2026-09-01', to: '2026-09-03' }, 31)).toEqual([
      { from: '2026-09-01', to: '2026-09-03' },
    ])
  })

  it('detects consecutive days', () => {
    expect(isConsecutive(['2026-09-01', '2026-09-02', '2026-09-03'])).toBe(true)
    expect(isConsecutive(['2026-09-01', '2026-09-03'])).toBe(false)
    expect(isConsecutive([])).toBe(true)
  })

  it('derives yesterday in UTC regardless of the wall clock', () => {
    expect(yesterdayUtc(new Date('2026-09-12T00:30:00Z'))).toBe('2026-09-11')
  })
})
