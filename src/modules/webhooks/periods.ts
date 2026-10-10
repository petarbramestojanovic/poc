import { addDays, dayOfWeek, todayIn, type DateWindow, type IsoDate } from '../../core/dates.ts'
import { InvalidScheduleError } from './errors.ts'

// How often a webhook reports and which days each report covers. Always a whole period that has
// ENDED in the webhook's own timezone — never a partial one, and never derived from the server
// clock: `now` is a point in time, and the calendar day it falls on is resolved in `timezone`
// (CLAUDE.md rule 7).
//
// A frequency is stored as app.webhook.report_window (RFC-004): daily = previous_day, weekly =
// previous_week, monthly = previous_month. The cron decides when a report is sent; the frequency
// decides what it covers, so a custom cron never changes the period.

export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
export type Frequency = (typeof FREQUENCIES)[number]

/** app.webhook.report_window, the column a frequency is stored in. */
export type ReportWindow = 'previous_day' | 'previous_week' | 'previous_month'

const WINDOWS: Readonly<Record<Frequency, ReportWindow>> = {
  daily: 'previous_day',
  weekly: 'previous_week',
  monthly: 'previous_month',
}

/**
 * When a webhook is sent unless it names its own cron: 05:00, an hour after the 04:00 nightly sync,
 * on Mondays for a week and on the 1st for a month. A report still waits for its data (scheduler.ts).
 */
export const DEFAULT_CRON: Readonly<Record<Frequency, string>> = {
  daily: '0 5 * * *',
  weekly: '0 5 * * 1',
  monthly: '0 5 1 * *',
}

export function windowOf(frequency: Frequency): ReportWindow {
  return WINDOWS[frequency]
}

export function frequencyOf(window: ReportWindow): Frequency {
  const found = FREQUENCIES.find((frequency) => WINDOWS[frequency] === window)
  // report_window is a CHECK-constrained column; a value outside it means the row is unusable.
  if (found === undefined) throw new InvalidScheduleError(`unknown report window ${window}`)
  return found
}

const MONDAY = 1

export function reportPeriod(frequency: Frequency, timezone: string, now: Date): DateWindow {
  const today = todayIn(timezone, now)
  switch (frequency) {
    case 'daily': {
      const day = addDays(today, -1)
      return { from: day, to: day }
    }
    case 'weekly': {
      // ISO weeks: Monday to Sunday, the week before the one `today` falls in.
      const sinceMonday = (dayOfWeek(today) - MONDAY + 7) % 7
      const monday = addDays(today, -sinceMonday)
      return { from: addDays(monday, -7), to: addDays(monday, -1) }
    }
    case 'monthly': {
      const firstOfThisMonth = startOfMonth(today)
      const lastOfPreviousMonth = addDays(firstOfThisMonth, -1)
      return { from: startOfMonth(lastOfPreviousMonth), to: lastOfPreviousMonth }
    }
    default: {
      throw new InvalidScheduleError(`unknown frequency ${String(frequency)}`)
    }
  }
}

function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`
}
