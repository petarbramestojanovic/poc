import { addDays, dayOfWeek, todayIn, type DateWindow, type IsoDate } from '../dates.ts'
import { InvalidScheduleError } from './errors.ts'

// Which days a scheduled report covers. Always a whole period that has ENDED in the webhook's own
// timezone — never a partial one, and never derived from the server clock: `now` is a point in
// time, and the calendar day it falls on is resolved in `timezone` (CLAUDE.md rule 7).

export type ReportWindow = 'previous_day' | 'previous_week' | 'previous_month'

export const REPORT_WINDOWS: readonly ReportWindow[] = [
  'previous_day',
  'previous_week',
  'previous_month',
]

const MONDAY = 1

export function reportPeriod(window: ReportWindow, timezone: string, now: Date): DateWindow {
  const today = todayIn(timezone, now)
  switch (window) {
    case 'previous_day': {
      const day = addDays(today, -1)
      return { from: day, to: day }
    }
    case 'previous_week': {
      // ISO weeks: Monday to Sunday, the week before the one `today` falls in.
      const sinceMonday = (dayOfWeek(today) - MONDAY + 7) % 7
      const monday = addDays(today, -sinceMonday)
      return { from: addDays(monday, -7), to: addDays(monday, -1) }
    }
    case 'previous_month': {
      const firstOfThisMonth = startOfMonth(today)
      const lastOfPreviousMonth = addDays(firstOfThisMonth, -1)
      return { from: startOfMonth(lastOfPreviousMonth), to: lastOfPreviousMonth }
    }
    default: {
      // report_window is a CHECK-constrained column; a value outside it means the row is unusable.
      throw new InvalidScheduleError(`unknown report window ${String(window)}`)
    }
  }
}

function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`
}
