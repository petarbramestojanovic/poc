import type { Queryable } from '../../core/db.ts'
import type { IsoDate } from '../../core/dates.ts'
import { loadSql } from '../../core/sql-file.ts'
import { TRACKED_FIELDS, type PageEvent } from './event.ts'

// Every statement of the page tracker. SQL lives in ./sql/*.sql and is read at import time. This
// module reads app.campaign (does the campaign exist, is it archived) with its own SQL and imports
// no other module.
const sql = loadSql(import.meta.url, ['day_zone', 'upsert_event'] as const)

/** external.source.day_timezone of 'brame', the zone a page event's day is counted in. */
export async function loadDayZone(q: Queryable): Promise<string> {
  const rows = await q.query<{ day_timezone: string }>(sql.day_zone)
  const zone = rows[0]?.day_timezone
  if (zone === undefined) throw new Error("external.source has no 'brame' row")
  return zone
}

/**
 * Counts one event on its row. Undefined when the campaign does not exist or is archived (nothing
 * was written); otherwise whether it landed on the day's overflow row.
 */
export async function countEvent(
  q: Queryable,
  event: PageEvent,
  day: IsoDate,
  combinationCap: number,
): Promise<{ overflow: boolean } | undefined> {
  const rows = await q.query<{ overflow: boolean }>(sql.upsert_event, [
    event.campaignId,
    day,
    event.language,
    ...TRACKED_FIELDS.map((field) => event.values[field]),
    event.event === 'visit' ? 1 : 0,
    event.event === 'conversion' ? 1 : 0,
    combinationCap,
  ])
  const row = rows[0]
  return row === undefined ? undefined : { overflow: row.overflow }
}
