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
  'set_industry_manual',
  'list_unclassified',
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

/** A campaign's industry and who set it, as the manual route answers. */
export interface IndustryAssignment {
  id: string
  industry: string | null
  industrySource: IndustrySource | null
}

/** A person's value (source 'manual'), or null to clear both; undefined when no such campaign. */
export async function setIndustryManual(
  q: Queryable,
  campaignId: string,
  industry: string | null,
): Promise<IndustryAssignment | undefined> {
  const rows = await q.query<{
    id: string
    industry: string | null
    industry_source: IndustrySource | null
  }>(sql.set_industry_manual, [campaignId, industry])
  const row = rows[0]
  return row === undefined
    ? undefined
    : { id: row.id, industry: row.industry, industrySource: row.industry_source }
}

/** A campaign the backfill walks over: what the keyword table reads, and what it has now. */
export interface BackfillCandidate {
  id: string
  /** The CRM's id (the Salesforce opportunity), which an operator recognises. */
  externalId: string | null
  name: string
  companyName: string
  industry: string | null
  industrySource: IndustrySource | null
}

/** Those without an industry; with `reclassify`, also those not set by a person. Oldest first. */
export async function listUnclassified(
  q: Queryable,
  reclassify: boolean,
): Promise<BackfillCandidate[]> {
  const rows = await q.query<{
    id: string
    external_id: string | null
    name: string
    company_name: string
    industry: string | null
    industry_source: IndustrySource | null
  }>(sql.list_unclassified, [reclassify])
  return rows.map((row) => ({
    id: row.id,
    externalId: row.external_id,
    name: row.name,
    companyName: row.company_name,
    industry: row.industry,
    industrySource: row.industry_source,
  }))
}
