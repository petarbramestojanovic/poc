import type { Queryable } from '../../../core/db.ts'
import type { DateWindow } from '../../../core/dates.ts'
import type { Logger } from '../../../core/log.ts'
import type { Frequency } from '../../webhooks/periods.ts'
import { InvalidEmailReportError } from '../errors.ts'
import { rowsKind } from './rows.ts'

// What a report is. The module (tick, deliveries, retries, routes, the mail layer) works the same
// for every kind; a kind answers how its settings are checked, whether a period's data is complete,
// and what file a period produces. A new kind is a file beside rows.ts, a line in REPORT_KINDS, and
// its name added to app.email_report.kind's CHECK in a migration.

/** Which campaigns a report covers, and in which timezone and frequency its periods are counted. */
export interface ReportScope {
  id: string
  companyId: string
  /** null = every campaign of the company, including ones created later. */
  campaignIds: readonly string[] | null
  timezone: string
  frequency: Frequency
}

export interface BuiltReport {
  /** Stored on the delivery row and attached to the email, byte for byte. */
  document: string
  /** e.g. "text/csv; charset=utf-8". */
  contentType: string
  /** 0 = the period has nothing to report: the schedule sends nothing, send-now refuses. */
  rowCount: number
}

/** A report's stored settings, read and ready. */
export interface PreparedReport {
  /**
   * The names of the campaigns whose data does not cover the period yet. A scheduled report waits
   * while this is not empty, until the noon deadline. Empty = ready, or a kind that never waits.
   */
  incomplete(q: Queryable, scope: ReportScope, period: DateWindow): Promise<string[]>
  /** The file for one period; rowCount 0 when it has nothing to report (it is not sent). */
  build(
    q: Queryable,
    scope: ReportScope,
    period: DateWindow,
    /** Rendered into the document where the kind has a place for it; null in a preview. */
    deliveryId: string | null,
    generatedAt: Date,
    log: Logger,
  ): Promise<BuiltReport>
}

export interface ReportKind {
  /**
   * Checks settings as an admin sends them, against the database where needed, and returns what is
   * stored, with what the admin should know (never a reason to refuse).
   */
  validate(
    q: Queryable,
    input: unknown,
    scope: Pick<ReportScope, 'companyId' | 'campaignIds'>,
  ): Promise<{ settings: Record<string, unknown>; warnings: string[] }>
  /**
   * Stored settings, ready to build with. They were checked when saved, so a failure means the row
   * was edited by hand: InvalidEmailReportError.
   */
  prepare(stored: unknown): PreparedReport
}

export const REPORT_KINDS = { rows: rowsKind } as const satisfies Record<string, ReportKind>

export type KindName = keyof typeof REPORT_KINDS
export const KIND_NAMES = Object.keys(REPORT_KINDS) as [KindName, ...KindName[]]

export function kindOf(name: string): ReportKind {
  if (!Object.hasOwn(REPORT_KINDS, name)) {
    throw new InvalidEmailReportError(
      `unknown report kind "${name}"; one of ${KIND_NAMES.join(', ')}`,
    )
  }
  return REPORT_KINDS[name as KindName]
}
