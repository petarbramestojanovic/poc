import { addDays, yesterdayIn, type DateWindow } from '../dates.ts'
import type { SourceRecord } from './types.ts'

// The window a routine sync pulls: the source's lookback (or deep lookback) ending at the newest
// complete day in the source's own day zone (RFC-003 §1, §5). The nightly pass, the trigger route
// and the CLI all use it, so "re-sync the last 7 days" means the same days everywhere.

export type LookbackSource = Pick<
  SourceRecord,
  'id' | 'dayTimezone' | 'lookbackDays' | 'deepLookbackDays'
>

export function lookbackWindow(
  source: LookbackSource,
  options: { deep: boolean; now: Date },
): DateWindow {
  const days = options.deep ? source.deepLookbackDays : source.lookbackDays
  if (!Number.isInteger(days) || days < 1) {
    const kind = options.deep ? 'deep lookback' : 'lookback'
    throw new RangeError(`source ${source.id} has no ${kind} (${days} days)`)
  }
  const to = yesterdayIn(source.dayTimezone, options.now)
  return { from: addDays(to, -(days - 1)), to }
}
