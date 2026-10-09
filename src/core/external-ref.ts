import { z } from 'zod'

// Who owns the id another system knows one of our rows by (migration 0004): a company or a
// campaign pushed by a CRM carries one, so the same record pushed twice finds the same row. It
// identifies the row and never describes it.

export const externalRefSchema = z.strictObject({
  system: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'a short lowercase slug such as "salesforce"'),
  id: z.string().trim().min(1).max(255),
})
export type ExternalRef = z.infer<typeof externalRefSchema>

/** The two columns a row stores a reference in: both set, or both NULL. */
export interface ExternalRefColumns {
  external_system: string | null
  external_id: string | null
}

export const toExternalRef = (row: ExternalRefColumns): ExternalRef | null =>
  row.external_system !== null && row.external_id !== null
    ? { system: row.external_system, id: row.external_id }
    : null
