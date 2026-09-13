import { describe, expect, it } from 'vitest'
import {
  addDays,
  assertIsoDate,
  chunkWindow,
  dayOfWeek,
  daysInclusive,
  eachDay,
  isConsecutive,
  startOfDayIn,
  todayIn,
  yesterdayIn,
  yesterdayUtc,
} from '../../src/dates.ts'

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(assertIsoDate('2026-02-28')).toBe('2026-02-28')
    expect(assertIsoDate('2028-02-29')).toBe('2028-02-29')
    expect(() => assertIsoDate('2026-2-8')).toThrow(RangeError)
    expect(() => assertIsoDate('2026-13-01')).toThrow(RangeError)
  })

  it.each(['2026-02-31', '2026-04-31', '2027-02-29', '2026-00-10', '2026-06-00'])(
    'rejects the impossible calendar date %s instead of rolling it over',
    (value) => {
      expect(() => assertIsoDate(value)).toThrow(RangeError)
    },
  )

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

  it('names the weekday of a calendar day', () => {
    expect(dayOfWeek('2026-09-13')).toBe(0) // Sunday
    expect(dayOfWeek('2026-09-14')).toBe(1)
    expect(dayOfWeek('2026-09-12')).toBe(6)
  })

  it('detects consecutive days', () => {
    expect(isConsecutive(['2026-09-01', '2026-09-02', '2026-09-03'])).toBe(true)
    expect(isConsecutive(['2026-09-01', '2026-09-03'])).toBe(false)
    expect(isConsecutive([])).toBe(true)
  })

  it('derives yesterday in UTC regardless of the wall clock', () => {
    expect(yesterdayUtc(new Date('2026-09-12T00:30:00Z'))).toBe('2026-09-11')
  })

  it('derives today and yesterday in an explicit time zone, not the server clock', () => {
    const lateUtc = new Date('2026-09-11T23:30:00Z') // 01:30 on the 12th in Zurich (CEST)
    expect(todayIn('UTC', lateUtc)).toBe('2026-09-11')
    expect(todayIn('Europe/Zurich', lateUtc)).toBe('2026-09-12')
    expect(yesterdayIn('Europe/Zurich', lateUtc)).toBe('2026-09-11')
    expect(yesterdayIn('America/New_York', lateUtc)).toBe('2026-09-10')
  })

  it('finds the start of a calendar day in a zone, across both DST changes', () => {
    expect(startOfDayIn('2026-09-12', 'UTC').toISOString()).toBe('2026-09-12T00:00:00.000Z')
    expect(startOfDayIn('2026-09-12', 'Europe/Zurich').toISOString()).toBe(
      '2026-09-11T22:00:00.000Z',
    )
    expect(startOfDayIn('2026-01-15', 'Europe/Zurich').toISOString()).toBe(
      '2026-01-14T23:00:00.000Z',
    )
    expect(startOfDayIn('2026-03-29', 'Europe/Zurich').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    )
    expect(startOfDayIn('2026-10-25', 'Europe/Zurich').toISOString()).toBe(
      '2026-10-24T22:00:00.000Z',
    )
  })

  it('rejects an unknown time zone with a clear error', () => {
    expect(() => todayIn('Mars/Olympus')).toThrow('IANA')
  })
})
