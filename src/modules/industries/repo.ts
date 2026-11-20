import type { Queryable } from '../../core/db.ts'
import { loadSql } from '../../core/sql-file.ts'
import type { IndustrySource } from './map.ts'

// Every industries statement, one function each. SQL lives in ./sql/*.sql and is read at import
// time. This module reads and writes app.campaign's industry columns itself: nothing here goes
// through the campaigns module, which depends on this one and never the other way round.
const sql = loadSql(import.meta.url, [
  'load_for_classification',
  'list_industries',
  'set_industry_if_empty',
  'set_industry_unless_manual',
] as const)

export interface IndustryDefinition {
  name: string
  definition: string
}

/** What classifying a campaign goes by, and what it has now. */
export interface ClassificationSubject {
  id: string
  name: string
  companyName: string
  country: string | null
  industry: string | null
  industrySource: IndustrySource | null
}

export async function loadForClassification(
  q: Queryable,
  campaignId: string,
): Promise<ClassificationSubject | undefined> {
  const rows = await q.query<{
    id: string
    name: string
    company_name: string
    country: string | null
    industry: string | null
    industry_source: IndustrySource | null
  }>(sql.load_for_classification, [campaignId])
  const row = rows[0]
  return row === undefined
    ? undefined
    : {
        id: row.id,
        name: row.name,
        companyName: row.company_name,
        country: row.country,
        industry: row.industry,
        industrySource: row.industry_source,
      }
}

/** app.industry, ordered by name. */
export async function listIndustries(q: Queryable): Promise<IndustryDefinition[]> {
  return q.query<IndustryDefinition>(sql.list_industries)
}

/** Sets the industry only while the campaign has none; false when it had one by then. */
export async function setIndustryIfEmpty(
  q: Queryable,
  campaignId: string,
  industry: string,
  source: Exclude<IndustrySource, 'manual'>,
): Promise<boolean> {
  return (await q.query(sql.set_industry_if_empty, [campaignId, industry, source])).length === 1
}

/** Replaces a value the classifier set, never a person's; false when nothing was written. */
export async function setIndustryUnlessManual(
  q: Queryable,
  campaignId: string,
  industry: string,
  source: Exclude<IndustrySource, 'manual'>,
): Promise<boolean> {
  return (
    (await q.query(sql.set_industry_unless_manual, [campaignId, industry, source])).length === 1
  )
}
