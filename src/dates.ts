// Calendar-day arithmetic on 'YYYY-MM-DD' strings, always in UTC. The service never
// bucket days by the server clock: a day is whatever the source or the webhook says it is.

export type IsoDate = string

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function assertIsoDate(value: string): IsoDate {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new RangeError(`not a YYYY-MM-DD date: ${value}`)
  }
  return value
}

export function toDate(date: IsoDate): Date {
  return new Date(`${assertIsoDate(date)}T00:00:00Z`)
}

export function fromDate(date: Date): IsoDate {
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

export function todayUtc(now: Date = new Date()): IsoDate {
  return fromDate(now)
}

export function yesterdayUtc(now: Date = new Date()): IsoDate {
  return addDays(todayUtc(now), -1)
}
