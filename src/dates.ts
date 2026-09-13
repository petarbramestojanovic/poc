// Calendar-day arithmetic on 'YYYY-MM-DD' strings. Arithmetic is done in UTC because a
// calendar day has no time zone once it is written down; which *wall clock* decides "today"
// is always an explicit argument (`todayIn`/`yesterdayIn`). The service never buckets a day
// by the server clock: a day is whatever the source or the webhook says it is.

export type IsoDate = string

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Accepts only dates that exist. `Date.parse` rolls over (2026-02-31 → 1 March), so the
 * check is a round trip: parse, then require the formatted result to equal the input.
 */
export function assertIsoDate(value: string): IsoDate {
  const match = ISO_DATE.exec(value)
  if (!match) throw new RangeError(`not a YYYY-MM-DD date: ${value}`)
  const [, year, month, day] = match as unknown as [string, string, string, string]
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day))
  if (Number.isNaN(utc) || new Date(utc).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`not a calendar date: ${value}`)
  }
  return value
}

export function toDate(date: IsoDate): Date {
  return new Date(`${assertIsoDate(date)}T00:00:00Z`)
}

export function fromDate(date: Date): IsoDate {
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid Date')
  return date.toISOString().slice(0, 10)
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = toDate(date)
  d.setUTCDate(d.getUTCDate() + days)
  return fromDate(d)
}

/** Number of days from `from` to `to`, both inclusive. */
export function daysInclusive(from: IsoDate, to: IsoDate): number {
  const diff = (toDate(to).getTime() - toDate(from).getTime()) / 86_400_000
  if (diff < 0) throw new RangeError(`window end ${to} is before start ${from}`)
  return diff + 1
}

export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const count = daysInclusive(from, to)
  const days: IsoDate[] = []
  for (let i = 0; i < count; i++) days.push(addDays(from, i))
  return days
}

export function isConsecutive(dates: readonly IsoDate[]): boolean {
  let previous: IsoDate | undefined
  for (const date of dates) {
    if (previous !== undefined && addDays(previous, 1) !== date) return false
    previous = date
  }
  return true
}

export interface DateWindow {
  from: IsoDate
  to: IsoDate
}

/** Splits an inclusive window into consecutive windows of at most `maxDays` days. */
export function chunkWindow(window: DateWindow, maxDays: number): DateWindow[] {
  if (maxDays < 1) throw new RangeError('maxDays must be >= 1')
  const total = daysInclusive(window.from, window.to)
  const chunks: DateWindow[] = []
  for (let offset = 0; offset < total; offset += maxDays) {
    const from = addDays(window.from, offset)
    const to = addDays(window.from, Math.min(offset + maxDays, total) - 1)
    chunks.push({ from, to })
  }
  return chunks
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone)
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    } catch {
      throw new RangeError(`not an IANA time zone: ${timeZone}`)
    }
    dayFormatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * The calendar day `now` falls on in `timeZone` — an external.source.day_timezone or a
 * webhook's timezone, never the server's. Uses Intl, so it needs no dependency and no
 * timezone table of our own.
 */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  const parts = dayFormatter(timeZone).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value
  const [year, month, day] = [part('year'), part('month'), part('day')]
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError(`could not format a day in ${timeZone}`)
  }
  return assertIsoDate(`${year}-${month}-${day}`)
}

/** The newest complete day in `timeZone` — what Zeus serves and NEXD has settled. */
export function yesterdayIn(timeZone: string, now: Date = new Date()): IsoDate {
  return addDays(todayIn(timeZone, now), -1)
}

export function todayUtc(now: Date = new Date()): IsoDate {
  return todayIn('UTC', now)
}

export function yesterdayUtc(now: Date = new Date()): IsoDate {
  return yesterdayIn('UTC', now)
}

/** 0 = Sunday … 6 = Saturday: the weekday of a calendar day, which needs no zone once written down. */
export function dayOfWeek(date: IsoDate): number {
  return toDate(date).getUTCDay()
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function zoneOffsetMs(timeZone: string, instant: number): number {
  let formatter = offsetFormatters.get(timeZone)
  if (!formatter) {
    dayFormatter(timeZone) // validates the zone with a clear error
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    offsetFormatters.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(new Date(instant))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value)
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return wallAsUtc - Math.floor(instant / 1000) * 1000
}

/** The instant a calendar day begins in `timeZone` (00:00 local), DST-aware. */
export function startOfDayIn(date: IsoDate, timeZone: string): Date {
  const midnightUtc = toDate(date).getTime()
  const guess = midnightUtc - zoneOffsetMs(timeZone, midnightUtc)
  return new Date(midnightUtc - zoneOffsetMs(timeZone, guess))
}
