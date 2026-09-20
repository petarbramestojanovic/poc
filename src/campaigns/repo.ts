import type { Queryable } from '../db.ts'
import type { IsoDate } from '../dates.ts'
import { loadSql } from '../sql-file.ts'
import type { EntitySetup, ExternalRef, SourceSetup } from './input.ts'

// Every campaign-setup statement, one function each. SQL lives in ./sql/*.sql and is read at
// import time. Rows are turned into the camelCase records the service and the routes speak.
const sql = loadSql(import.meta.url, [
  'find_company',
  'find_company_by_ref',
  'find_company_by_name',
  'insert_company',
  'update_company_name',
  'list_companies',
  'find_campaign',
  'find_campaign_by_ref',
  'insert_campaign',
  'update_campaign',
  'find_source',
  'find_credentials',
  'find_link',
  'insert_link',
  'update_link',
  'insert_ctas',
  'insert_pages',
  'find_entity_owners',
  'insert_entities',
  'insert_event_map',
  'list_campaigns',
  'get_campaign',
] as const)

export type CampaignStatus = 'draft' | 'active' | 'archived'

export interface CompanyRecord {
  id: string
  name: string
  externalRef: ExternalRef | null
}

export interface CampaignRecord {
  id: string
  companyId: string
  name: string
  primarySource: string
  timezone: string
  languages: string[]
  startsOn: IsoDate | null
  endsOn: IsoDate | null
  status: CampaignStatus
  externalRef: ExternalRef | null
  createdAt: Date
  updatedAt: Date
}

/** The editable columns of a campaign, all of them: an edit writes the merged row back. */
export interface CampaignValues {
  name: string
  primarySource: string
  timezone: string
  languages: string[]
  startsOn: IsoDate | null
  endsOn: IsoDate | null
  status: CampaignStatus
}

interface ExternalRefColumns {
  external_system: string | null
  external_id: string | null
}

const toRef = (row: ExternalRefColumns): ExternalRef | null =>
  row.external_system !== null && row.external_id !== null
    ? { system: row.external_system, id: row.external_id }
    : null

interface CompanyRow extends ExternalRefColumns {
  id: string
  name: string
}

const toCompany = (row: CompanyRow): CompanyRecord => ({
  id: row.id,
  name: row.name,
  externalRef: toRef(row),
})

interface CampaignRow extends ExternalRefColumns {
  id: string
  company_id: string
  name: string
  primary_source: string
  timezone: string
  languages: string[]
  starts_on: IsoDate | null
  ends_on: IsoDate | null
  status: CampaignStatus
  created_at: Date
  updated_at: Date
}

const toCampaign = (row: CampaignRow): CampaignRecord => ({
  id: row.id,
  companyId: row.company_id,
  name: row.name,
  primarySource: row.primary_source,
  timezone: row.timezone,
  languages: row.languages,
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  status: row.status,
  externalRef: toRef(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const first = <Row, Out>(rows: Row[], map: (row: Row) => Out): Out | undefined =>
  rows[0] === undefined ? undefined : map(rows[0])

// --- companies ------------------------------------------------------------------------------

export async function findCompany(q: Queryable, id: string): Promise<CompanyRecord | undefined> {
  return first(await q.query<CompanyRow>(sql.find_company, [id]), toCompany)
}

export async function findCompanyByRef(
  q: Queryable,
  ref: ExternalRef,
): Promise<CompanyRecord | undefined> {
  return first(await q.query<CompanyRow>(sql.find_company_by_ref, [ref.system, ref.id]), toCompany)
}

export async function findCompanyByName(
  q: Queryable,
  name: string,
): Promise<CompanyRecord | undefined> {
  return first(await q.query<CompanyRow>(sql.find_company_by_name, [name]), toCompany)
}

export async function insertCompany(
  q: Queryable,
  name: string,
  ref: ExternalRef | undefined,
): Promise<CompanyRecord> {
  const rows = await q.query<CompanyRow>(sql.insert_company, [
    name,
    ref?.system ?? null,
    ref?.id ?? null,
  ])
  return toCompany(required(rows[0], 'insert_company'))
}

export async function updateCompanyName(
  q: Queryable,
  id: string,
  name: string,
): Promise<CompanyRecord> {
  const rows = await q.query<CompanyRow>(sql.update_company_name, [id, name])
  return toCompany(required(rows[0], 'update_company_name'))
}

export interface CompanyListItem extends CompanyRecord {
  campaigns: number
}

export async function listCompanies(q: Queryable): Promise<CompanyListItem[]> {
  const rows = await q.query<CompanyRow & { campaigns: number }>(sql.list_companies)
  return rows.map((row) => ({ ...toCompany(row), campaigns: row.campaigns }))
}

// --- campaigns ------------------------------------------------------------------------------

export async function findCampaignForUpdate(
  q: Queryable,
  id: string,
): Promise<CampaignRecord | undefined> {
  return first(await q.query<CampaignRow>(sql.find_campaign, [id]), toCampaign)
}

export async function findCampaignByRef(
  q: Queryable,
  ref: ExternalRef,
): Promise<CampaignRecord | undefined> {
  return first(
    await q.query<CampaignRow>(sql.find_campaign_by_ref, [ref.system, ref.id]),
    toCampaign,
  )
}

export interface NewCampaign {
  companyId: string
  name: string
  primarySource: string
  timezone: string | undefined
  languages: string[]
  startsOn: IsoDate | null
  endsOn: IsoDate | null
  status: CampaignStatus | undefined
  externalRef: ExternalRef | undefined
}

export async function insertCampaign(q: Queryable, campaign: NewCampaign): Promise<CampaignRecord> {
  const rows = await q.query<CampaignRow>(sql.insert_campaign, [
    campaign.companyId,
    campaign.name,
    campaign.primarySource,
    campaign.timezone ?? null,
    campaign.languages,
    campaign.startsOn,
    campaign.endsOn,
    campaign.status ?? null,
    campaign.externalRef?.system ?? null,
    campaign.externalRef?.id ?? null,
  ])
  return toCampaign(required(rows[0], 'insert_campaign'))
}

export async function updateCampaign(
  q: Queryable,
  id: string,
  values: CampaignValues,
): Promise<CampaignRecord> {
  const rows = await q.query<CampaignRow>(sql.update_campaign, [
    id,
    values.name,
    values.primarySource,
    values.timezone,
    values.languages,
    values.startsOn,
    values.endsOn,
    values.status,
  ])
  return toCampaign(required(rows[0], 'update_campaign'))
}

export interface LinkSummary {
  id: string
  source: string
  language: string
  enabled: boolean
  entities: number
}

export interface CampaignListItem extends CampaignRecord {
  companyName: string
  links: LinkSummary[]
}

export async function listCampaigns(
  q: Queryable,
  companyId: string | undefined,
): Promise<CampaignListItem[]> {
  const rows = await q.query<CampaignRow & { company_name: string; links: LinkSummary[] }>(
    sql.list_campaigns,
    [companyId ?? null],
  )
  return rows.map((row) => ({
    ...toCampaign(row),
    companyName: row.company_name,
    links: row.links,
  }))
}

export interface LinkDetail {
  id: string
  source: string
  language: string
  enabled: boolean
  config: Record<string, unknown>
  entities: {
    level: string
    externalId: string
    role: string | null
    label: string | null
    campaignTag: string
  }[]
}

export interface CampaignDetail extends CampaignRecord {
  companyName: string
  links: LinkDetail[]
}

export async function getCampaign(q: Queryable, id: string): Promise<CampaignDetail | undefined> {
  const rows = await q.query<CampaignRow & { company_name: string; links: LinkDetail[] }>(
    sql.get_campaign,
    [id],
  )
  return first(rows, (row) => ({
    ...toCampaign(row),
    companyName: row.company_name,
    links: row.links,
  }))
}

// --- sources, links and what hangs off them -------------------------------------------------

export interface SourceRow {
  id: string
  kind: 'own' | 'platform'
  enabled: boolean
}

export async function findSource(q: Queryable, id: string): Promise<SourceRow | undefined> {
  return (await q.query<SourceRow>(sql.find_source, [id]))[0]
}

export interface CredentialChoice {
  id: string
  name: string
}

export async function findCredentials(q: Queryable, sourceId: string): Promise<CredentialChoice[]> {
  return q.query<CredentialChoice>(sql.find_credentials, [sourceId])
}

export interface LinkRow {
  id: string
  credentialId: string
  config: Record<string, unknown>
}

export async function findLink(
  q: Queryable,
  campaignId: string,
  sourceId: string,
  language: string,
): Promise<LinkRow | undefined> {
  const rows = await q.query<{
    id: string
    credential_id: string
    config: Record<string, unknown>
  }>(sql.find_link, [campaignId, sourceId, language])
  return first(rows, (row) => ({
    id: row.id,
    credentialId: row.credential_id,
    config: row.config,
  }))
}

export async function insertLink(
  q: Queryable,
  link: {
    campaignId: string
    sourceId: string
    credentialId: string
    language: string
    config: unknown
  },
): Promise<string> {
  const rows = await q.query<{ id: string }>(sql.insert_link, [
    link.campaignId,
    link.sourceId,
    link.credentialId,
    link.language,
    JSON.stringify(link.config),
  ])
  return required(rows[0], 'insert_link').id
}

export async function updateLink(
  q: Queryable,
  id: string,
  credentialId: string,
  config: unknown,
): Promise<void> {
  await q.query(sql.update_link, [id, credentialId, JSON.stringify(config)])
}

export async function insertCtas(
  q: Queryable,
  campaignId: string,
  ctas: SourceSetup['ctas'],
): Promise<void> {
  if (ctas.length === 0) return
  await q.query(sql.insert_ctas, [
    campaignId,
    ctas.map((cta) => cta.ctaId),
    ctas.map((cta) => cta.name),
    ctas.map((cta) => cta.url ?? null),
    ctas.map((cta) => cta.isInternalEvent),
    ctas.map((cta) => cta.sortOrder ?? null),
  ])
}

export async function insertPages(
  q: Queryable,
  campaignId: string,
  pages: SourceSetup['pages'],
): Promise<void> {
  if (pages.length === 0) return
  await q.query(sql.insert_pages, [
    campaignId,
    pages.map((page) => page.pageId),
    pages.map((page) => page.name),
    pages.map((page) => page.sortOrder ?? null),
  ])
}

export interface EntityOwner {
  level: string
  externalId: string
  campaignId: string
  campaignName: string
}

/** The entities of `wanted` that already belong to a link other than `linkId`. */
export async function findEntityOwners(
  q: Queryable,
  sourceId: string,
  linkId: string,
  wanted: readonly EntitySetup[],
): Promise<EntityOwner[]> {
  const rows = await q.query<{
    level: string
    external_id: string
    campaign_id: string
    campaign_name: string
  }>(sql.find_entity_owners, [
    sourceId,
    linkId,
    wanted.map((entity) => entity.level),
    wanted.map((entity) => entity.externalId),
  ])
  return rows.map((row) => ({
    level: row.level,
    externalId: row.external_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
  }))
}

/** Inserts the entities the link does not have yet and returns how many that was. */
export async function insertEntities(
  q: Queryable,
  linkId: string,
  sourceId: string,
  entities: readonly EntitySetup[],
): Promise<number> {
  const rows = await q.query(sql.insert_entities, [
    linkId,
    sourceId,
    entities.map((entity) => entity.level),
    entities.map((entity) => entity.externalId),
    entities.map((entity) => entity.role ?? null),
    entities.map((entity) => entity.label ?? null),
    entities.map((entity) => entity.campaignTag),
  ])
  return rows.length
}

export async function insertEventMap(
  q: Queryable,
  linkId: string,
  eventMap: SourceSetup['eventMap'],
): Promise<void> {
  if (eventMap.length === 0) return
  await q.query(sql.insert_event_map, [
    linkId,
    eventMap.map((entry) => entry.eventName),
    eventMap.map((entry) => entry.targetKind),
    eventMap.map((entry) => entry.targetId ?? null),
  ])
}

function required<T>(row: T | undefined, statement: string): T {
  if (row === undefined) throw new Error(`${statement} returned no row`)
  return row
}
