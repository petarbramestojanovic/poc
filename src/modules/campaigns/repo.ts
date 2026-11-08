import type { Queryable } from '../../core/db.ts'
import type { IsoDate } from '../../core/dates.ts'
import { loadSql } from '../../core/sql-file.ts'
import {
  toExternalRef,
  type ExternalRef,
  type ExternalRefColumns,
} from '../../core/external-ref.ts'
import type { ProvisionedResourceRecord } from '../sync/types.ts'
import type { Amount, EntitySetup, Price, SourceSetup } from './input.ts'

// Every campaign-setup statement, one function each. SQL lives in ./sql/*.sql and is read at
// import time. Rows are turned into the camelCase records the service and the routes speak.
const sql = loadSql(import.meta.url, [
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
  'update_entity_labels',
  'insert_event_map',
  'list_link_entities',
  'link_activity',
  'delete_link',
  'list_link_sources',
  'list_campaigns',
  'get_campaign',
  'insert_creative',
  'list_creatives',
  'update_creative_names',
  'list_provisioned_resources',
] as const)

export type CampaignStatus = 'draft' | 'active' | 'archived'

export interface CampaignManager {
  id: string
  name: string | null
}

/** What the CRM says about the deal behind a campaign. Any part of it may not be known. */
export interface CampaignDealFields {
  amount: Amount | null
  dealType: string | null
  country: string | null
  creativeTypes: string[]
  ownerName: string | null
  manager: CampaignManager | null
  externalModifiedAt: string | null
}

export interface CampaignRecord extends CampaignDealFields {
  id: string
  companyId: string
  name: string
  primarySource: string
  timezone: string
  languages: string[]
  startsOn: IsoDate | null
  endsOn: IsoDate | null
  status: CampaignStatus
  price: Price | null
  externalRef: ExternalRef | null
  createdAt: Date
  updatedAt: Date
}

/** The editable columns of a campaign, all of them: an edit writes the merged row back. */
export interface CampaignValues extends CampaignDealFields {
  name: string
  primarySource: string
  timezone: string
  languages: string[]
  startsOn: IsoDate | null
  endsOn: IsoDate | null
  status: CampaignStatus
  price: Price | null
}

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
  /** numeric comes back as its decimal text, e.g. '5.316860' (numeric(14,6) pads '20.4' to '20.400000'). */
  price: string | null
  currency: string | null
  /** numeric comes back as its decimal text, e.g. '7128.70'. */
  amount: string | null
  amount_currency: string | null
  deal_type: string | null
  country: string | null
  creative_types: string[]
  owner_name: string | null
  manager_external_id: string | null
  manager_name: string | null
  external_modified_at: Date | null
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
  // The table keeps price and currency both set or both NULL (campaign_price_pair).
  price:
    row.price !== null && row.currency !== null
      ? { value: Number(row.price), currency: row.currency }
      : null,
  // The table keeps these two both set or both NULL (campaign_amount_pair).
  amount:
    row.amount !== null && row.amount_currency !== null
      ? { value: Number(row.amount), currency: row.amount_currency }
      : null,
  dealType: row.deal_type,
  country: row.country,
  creativeTypes: row.creative_types,
  ownerName: row.owner_name,
  manager:
    row.manager_external_id === null
      ? null
      : { id: row.manager_external_id, name: row.manager_name },
  externalModifiedAt: row.external_modified_at?.toISOString() ?? null,
  externalRef: toExternalRef(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const first = <Row, Out>(rows: Row[], map: (row: Row) => Out): Out | undefined =>
  rows[0] === undefined ? undefined : map(rows[0])

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

export interface NewCampaign extends CampaignDealFields {
  companyId: string
  name: string
  primarySource: string
  timezone: string | undefined
  languages: string[]
  startsOn: IsoDate | null
  endsOn: IsoDate | null
  status: CampaignStatus | undefined
  price: Price | null
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
    ...priceParams(campaign.price),
    ...dealParams(campaign),
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
    ...priceParams(values.price),
    ...dealParams(values),
  ])
  return toCampaign(required(rows[0], 'update_campaign'))
}

/** The price as its decimal text, so the numeric column stores exactly what was validated. */
const priceParams = (price: Price | null): [string | null, string | null] =>
  price === null ? [null, null] : [String(price.value), price.currency]

/** In the order of insert_campaign.sql and update_campaign.sql, which both end with these. */
const dealParams = (deal: CampaignDealFields): unknown[] => [
  deal.amount === null ? null : String(deal.amount.value),
  deal.amount?.currency ?? null,
  deal.dealType,
  deal.country,
  deal.creativeTypes,
  deal.ownerName,
  deal.manager?.id ?? null,
  deal.manager?.name ?? null,
  deal.externalModifiedAt,
]

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
    /** The creative the entity's rows belong to; null on the campaign's own row. */
    creativeId: string | null
  }[]
}

/** A creative as the detail route shows it (jsonb_agg hands the timestamp over as ISO text). */
export interface CreativeSummary {
  id: string
  tag: string
  type: string | null
  name: string
  createdAt: string
}

export interface CampaignDetail extends CampaignRecord {
  companyName: string
  creatives: CreativeSummary[]
  links: LinkDetail[]
}

export async function getCampaign(q: Queryable, id: string): Promise<CampaignDetail | undefined> {
  const rows = await q.query<
    CampaignRow & { company_name: string; creatives: CreativeSummary[]; links: LinkDetail[] }
  >(sql.get_campaign, [id])
  return first(rows, (row) => ({
    ...toCampaign(row),
    companyName: row.company_name,
    creatives: row.creatives,
    links: row.links,
  }))
}

// --- creatives ------------------------------------------------------------------------------

/** One creative of a campaign (app.creative, migration 0011): ours, pointed at by platform ids. */
export interface CreativeRecord {
  id: string
  campaignId: string
  /** What the writer stamps on its rows; the creative's own id unless it was keyed by hand. */
  tag: string
  type: string | null
  name: string
  createdAt: Date
  updatedAt: Date
}

interface CreativeRow {
  id: string
  campaign_id: string
  tag: string
  type: string | null
  name: string
  created_at: Date
  updated_at: Date
}

const toCreative = (row: CreativeRow): CreativeRecord => ({
  id: row.id,
  campaignId: row.campaign_id,
  tag: row.tag,
  type: row.type,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export async function listCreatives(q: Queryable, campaignId: string): Promise<CreativeRecord[]> {
  return (await q.query<CreativeRow>(sql.list_creatives, [campaignId])).map(toCreative)
}

/** A new creative. `tag` null = its own id, the rule for every creative created from now on. */
export async function insertCreative(
  q: Queryable,
  creative: { campaignId: string; tag: string | null; type: string | null; name: string },
): Promise<CreativeRecord> {
  const rows = await q.query<CreativeRow>(sql.insert_creative, [
    creative.campaignId,
    creative.tag,
    creative.type,
    creative.name,
  ])
  return toCreative(required(rows[0], 'insert_creative'))
}

/** After a relabel: a creative's name follows its own entity's label. Returns how many changed. */
export async function updateCreativeNames(q: Queryable, linkId: string): Promise<number> {
  return (await q.query(sql.update_creative_names, [linkId])).length
}

/** What the platforms created for the campaign (external.provisioned_resource), oldest first. */
export async function listProvisionedResources(
  q: Queryable,
  campaignId: string,
): Promise<ProvisionedResourceRecord[]> {
  const rows = await q.query<{
    source_id: string
    kind: string
    external_id: string
    creative_id: string | null
  }>(sql.list_provisioned_resources, [campaignId])
  return rows.map((row) => ({
    source: row.source_id,
    kind: row.kind,
    externalId: row.external_id,
    creativeId: row.creative_id,
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

/** An entity as it is stored: its tag settled, pointing at the creative whose tag it is. */
export interface StoredEntity extends Omit<EntitySetup, 'campaignTag' | 'creativeType'> {
  campaignTag: string
  creativeId: string | null
}

/** Inserts the entities the link does not have yet and returns how many that was. */
export async function insertEntities(
  q: Queryable,
  linkId: string,
  sourceId: string,
  entities: readonly StoredEntity[],
): Promise<number> {
  if (entities.length === 0) return 0
  const rows = await q.query(sql.insert_entities, [
    linkId,
    sourceId,
    entities.map((entity) => entity.level),
    entities.map((entity) => entity.externalId),
    entities.map((entity) => entity.role ?? null),
    entities.map((entity) => entity.label ?? null),
    entities.map((entity) => entity.campaignTag),
    entities.map((entity) => entity.creativeId),
  ])
  return rows.length
}

/** Renames the entities whose label the request states differently; returns how many that was. */
export async function updateEntityLabels(
  q: Queryable,
  linkId: string,
  entities: readonly EntitySetup[],
): Promise<number> {
  const rows = await q.query(sql.update_entity_labels, [
    linkId,
    entities.map((entity) => entity.level),
    entities.map((entity) => entity.externalId),
    entities.map((entity) => entity.label ?? null),
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

/** A link's platform ids as they are stored, in the shape a setup states them. */
export async function listLinkEntities(q: Queryable, linkId: string): Promise<StoredEntity[]> {
  const rows = await q.query<{
    level: EntitySetup['level']
    external_id: string
    role: string | null
    label: string | null
    campaign_tag: string
    creative_id: string | null
  }>(sql.list_link_entities, [linkId])
  return rows.map((row) => ({
    level: row.level,
    externalId: row.external_id,
    ...(row.role === null ? {} : { role: row.role }),
    ...(row.label === null ? {} : { label: row.label }),
    campaignTag: row.campaign_tag,
    creativeId: row.creative_id,
  }))
}

export interface LinkActivity {
  /** A real sync run is fetching with the current ids. */
  running: boolean
  /** Analytics rows exist for this link's campaign, source and language. */
  hasData: boolean
}

/** Read under the link's sync-run gate lock, so no run can open between this and the change. */
export async function linkActivity(
  q: Queryable,
  link: { id: string; campaignId: string; sourceId: string; language: string },
): Promise<LinkActivity> {
  const rows = await q.query<{ running: boolean; has_data: boolean }>(sql.link_activity, [
    link.id,
    link.campaignId,
    link.sourceId,
    link.language,
  ])
  const row = required(rows[0], 'link_activity')
  return { running: row.running, hasData: row.has_data }
}

export async function deleteLink(q: Queryable, linkId: string): Promise<void> {
  await q.query(sql.delete_link, [linkId])
}

export async function listLinkSources(q: Queryable, campaignId: string): Promise<string[]> {
  const rows = await q.query<{ source_id: string }>(sql.list_link_sources, [campaignId])
  return rows.map((row) => row.source_id)
}

function required<T>(row: T | undefined, statement: string): T {
  if (row === undefined) throw new Error(`${statement} returned no row`)
  return row
}
