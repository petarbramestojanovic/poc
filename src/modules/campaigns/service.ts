import type { Db, Tx } from '../../core/db.ts'
import type { Logger } from '../../core/log.ts'
import type { ConnectorRegistry } from '../sync/registry.ts'
import { derivesExternalIds, type DerivedExternalId, type ExternalIdInput } from '../sync/types.ts'
import {
  CampaignNotFoundError,
  CompanyMismatchError,
  CredentialNotResolvedError,
  EntityInUseError,
  InvalidSetupError,
  PlatformHasDataError,
  PlatformNotFoundError,
  PlatformSyncRunningError,
  SetupConflictError,
  UnsupportedSourceError,
} from './errors.ts'
import * as companies from '../companies/repo.ts'
import { lockCompany, resolveCompany } from '../companies/service.ts'
import type { CampaignSetup, EntitySetup, SourceSetup } from './input.ts'
import { headlineSource } from './presets.ts'
import * as repo from './repo.ts'
import { checkSources } from './validate.ts'

// The one way a campaign gets into the database. The Salesforce webhook (src/modules/salesforce/) calls
// setUpCampaign with a platform-neutral CampaignSetup, and any other CRM adapter would too.
//
// A setup is safe to send again. With an `externalRef` the second push finds the campaign it
// created and works on that one. What a push may do to an existing campaign is deliberately
// lopsided: it updates the campaign's own fields and it ADDS what is missing — a source, a pixel,
// a creative — but it never removes anything. A CRM record with an emptied field must not be able
// to stop a sync that works; removing is a deliberate act, done by a person.
//
// That person sets a campaign's platform ids, and nothing else, through setPlatformIds and
// removePlatform: ids may always be added, and changed or removed only while that platform has
// written no analytics for the campaign.
//
// Everything happens in one transaction: either the campaign is fully set up, or nothing changed.

export interface CampaignDeps {
  db: Db
  /** The connectors decide which entities, roles and config a source accepts. */
  registry: ConnectorRegistry
  log: Logger
}

export interface LinkResult {
  id: string
  source: string
  language: string
  /** False when the link already existed and was only added to. */
  created: boolean
  entitiesAdded: number
  /** Creatives this source's new ids brought into being (app.creative). */
  creativesAdded: number
}

export interface CampaignSetupResult {
  /** False when an `externalRef` matched a campaign that was already there. */
  created: boolean
  /** True when that existing campaign's own fields changed. */
  updated: boolean
  company: companies.CompanyRecord
  campaign: repo.CampaignRecord
  links: LinkResult[]
}

export async function setUpCampaign(
  deps: CampaignDeps,
  setup: CampaignSetup,
): Promise<CampaignSetupResult> {
  // Refused before the first statement: what no connector would accept.
  const sources = checkSources(deps.registry, setup.sources)

  const result = await translatingConflicts(() =>
    deps.db.withTransaction(async (tx) => {
      // Lock order is always company, then campaign, so two setups can never deadlock.
      await lockCompany(tx, setup.company)
      if (setup.externalRef) {
        await tx.xactLock(`campaign-setup:${setup.externalRef.system}:${setup.externalRef.id}`)
      }

      const existing = setup.externalRef
        ? await repo.findCampaignByRef(tx, setup.externalRef)
        : undefined
      const known = existing ? await companies.findCompany(tx, existing.companyId) : undefined
      const company = await resolveCompany(tx, setup.company, known)
      if (existing && existing.companyId !== company.id) {
        throw new CompanyMismatchError(
          `campaign ${existing.id} belongs to another company; a campaign is never moved`,
        )
      }

      const pushed = existing ? await applyPush(tx, existing, setup) : undefined
      const campaign = pushed?.campaign ?? (await createCampaign(tx, company.id, setup, sources))

      const links: LinkResult[] = []
      for (const source of sources) links.push(await applySource(tx, campaign.id, source))

      return { created: !existing, updated: pushed?.updated ?? false, company, campaign, links }
    }),
  )

  deps.log.info(
    {
      campaignId: result.campaign.id,
      created: result.created,
      links: result.links.map((link) => ({
        source: link.source,
        created: link.created,
        entitiesAdded: link.entitiesAdded,
        creativesAdded: link.creativesAdded,
      })),
    },
    result.created ? 'campaign set up' : 'campaign setup applied to an existing campaign',
  )
  return result
}

// --- campaign -------------------------------------------------------------------------------

async function createCampaign(
  tx: Tx,
  companyId: string,
  setup: CampaignSetup,
  sources: readonly SourceSetup[],
): Promise<repo.CampaignRecord> {
  const primarySource =
    setup.primarySource ?? headlineSource(sources.map((source) => source.source))
  await assertSourceExists(tx, primarySource)

  return repo.insertCampaign(tx, {
    companyId,
    name: setup.name,
    primarySource,
    timezone: setup.timezone,
    // Not given: the languages the links are split by ('' = not split, so it is not a language).
    languages: setup.languages ?? [
      ...new Set(sources.map((source) => source.language).filter(Boolean)),
    ],
    startsOn: setup.startsOn ?? null,
    endsOn: setup.endsOn ?? null,
    status: setup.status,
    price: setup.price ?? null,
    amount: setup.amount ?? null,
    dealType: setup.dealType ?? null,
    country: setup.country ?? null,
    creativeTypes: setup.creativeTypes ?? [],
    ownerName: setup.ownerName ?? null,
    manager: nextManager(null, setup.manager),
    externalModifiedAt: setup.externalModifiedAt ?? null,
    externalRef: setup.externalRef,
  })
}

/**
 * A push updates what it states and leaves the rest: it cannot blank a field by omitting it or by
 * sending null. A push that changes nothing writes nothing, so updated_at keeps meaning "changed".
 */
async function applyPush(
  tx: Tx,
  current: repo.CampaignRecord,
  setup: CampaignSetup,
): Promise<{ campaign: repo.CampaignRecord; updated: boolean }> {
  const next: repo.CampaignValues = {
    name: setup.name,
    primarySource: setup.primarySource ?? current.primarySource,
    timezone: setup.timezone ?? current.timezone,
    languages: setup.languages ?? current.languages,
    startsOn: setup.startsOn ?? current.startsOn,
    endsOn: setup.endsOn ?? current.endsOn,
    status: setup.status ?? current.status,
    price: setup.price ?? current.price,
    amount: setup.amount ?? current.amount,
    dealType: setup.dealType ?? current.dealType,
    country: setup.country ?? current.country,
    creativeTypes: setup.creativeTypes ?? current.creativeTypes,
    ownerName: setup.ownerName ?? current.ownerName,
    manager: nextManager(current.manager, setup.manager),
    externalModifiedAt: setup.externalModifiedAt ?? current.externalModifiedAt,
  }
  const unchanged = (Object.keys(next) as (keyof repo.CampaignValues)[]).every(
    (key) => JSON.stringify(next[key]) === JSON.stringify(current[key]),
  )
  if (unchanged) return { campaign: current, updated: false }
  if (next.primarySource !== current.primarySource) await assertSourceExists(tx, next.primarySource)
  return { campaign: await repo.updateCampaign(tx, current.id, next), updated: true }
}

/**
 * An id may come without its name. That keeps the name only while it is the same person: the
 * previous manager's name must not stay on the next manager's id.
 */
function nextManager(
  current: repo.CampaignManager | null,
  stated: CampaignSetup['manager'],
): repo.CampaignManager | null {
  if (stated === undefined) return current
  return {
    id: stated.id,
    name: stated.name ?? (current?.id === stated.id ? current.name : null),
  }
}

async function assertSourceExists(tx: Tx, sourceId: string): Promise<void> {
  if (!(await repo.findSource(tx, sourceId))) {
    throw new UnsupportedSourceError(`primarySource '${sourceId}' is not a known source`)
  }
}

// --- one source: link, definitions, entities, event map --------------------------------------

/**
 * The creatives a rebuilt link's ids pointed at before it was deleted, by `level/externalId`: the
 * same platform id gets the same creative back, so a creative survives its link.
 */
type CreativeReuse = ReadonlyMap<string, string>

const entityKey = (entity: { level: string; externalId: string }): string =>
  `${entity.level}/${entity.externalId}`

async function applySource(
  tx: Tx,
  campaignId: string,
  source: SourceSetup,
  reuse: CreativeReuse = new Map(),
): Promise<LinkResult> {
  const row = await repo.findSource(tx, source.source)
  if (row?.kind !== 'platform' || !row.enabled) {
    throw new UnsupportedSourceError(`source '${source.source}' is not an enabled platform source`)
  }

  const existing = await repo.findLink(tx, campaignId, source.source, source.language)
  let linkId: string
  if (existing) {
    linkId = existing.id
    const credentialId =
      source.credential === undefined
        ? existing.credentialId
        : await resolveCredential(tx, source.source, source.credential)
    const changed =
      credentialId !== existing.credentialId ||
      JSON.stringify(existing.config) !== JSON.stringify(source.config)
    if (changed) await repo.updateLink(tx, linkId, credentialId, source.config)
  } else {
    linkId = await repo.insertLink(tx, {
      campaignId,
      sourceId: source.source,
      credentialId: await resolveCredential(tx, source.source, source.credential),
      language: source.language,
      config: source.config,
    })
  }

  // Definitions first: the event-map trigger and the link's config both point at them.
  await repo.insertCtas(tx, campaignId, source.ctas)
  await repo.insertPages(tx, campaignId, source.pages)

  const owners = await repo.findEntityOwners(tx, source.source, linkId, source.entities)
  const [owner] = owners
  if (owner) {
    throw new EntityInUseError(
      `${source.source} ${owner.level} ${owner.externalId} already belongs to campaign '${owner.campaignName}' (${owner.campaignId})`,
    )
  }

  // Only the ids the link does not have yet get a creative settled: one it has keeps the creative
  // it points at, whatever the request says about its tag (a push never rewrites an entity).
  const current = new Set((await repo.listLinkEntities(tx, linkId)).map(entityKey))
  const missing = source.entities.filter((entity) => !current.has(entityKey(entity)))
  const { entities, creativesAdded } = await settleCreatives(
    tx,
    campaignId,
    source.source,
    missing,
    reuse,
  )
  const entitiesAdded = await repo.insertEntities(tx, linkId, source.source, entities)
  await repo.insertEventMap(tx, linkId, source.eventMap)

  return {
    id: linkId,
    source: source.source,
    language: source.language,
    created: !existing,
    entitiesAdded,
    creativesAdded,
  }
}

/**
 * Gives every new entity its creative (app.creative, migration 0011) and the tag it stamps.
 *
 *   creative entity, no tag   a creative of ours, tagged with its own id — or the one the same
 *                             platform id pointed at before its link was rebuilt
 *   creative entity, a tag    the campaign's creative with that tag, created with it if new: how
 *                             one creative is named on a second platform, or keyed by hand
 *   any entity, tag ''        the campaign's own row; no creative
 *   other entity, a tag       a pixel's fires count for a creative the campaign has — never one
 *                             the request would have to invent
 *
 * Creative entities go first, so a pixel may name a creative the same request sets up.
 */
async function settleCreatives(
  tx: Tx,
  campaignId: string,
  sourceId: string,
  wanted: readonly EntitySetup[],
  reuse: CreativeReuse,
): Promise<{ entities: repo.StoredEntity[]; creativesAdded: number }> {
  const byTag = new Map((await repo.listCreatives(tx, campaignId)).map((c) => [c.tag, c]))
  const byId = new Map([...byTag.values()].map((c) => [c.id, c]))
  let creativesAdded = 0

  const create = async (tag: string | null, entity: EntitySetup): Promise<repo.CreativeRecord> => {
    const creative = await repo.insertCreative(tx, {
      campaignId,
      tag,
      type: entity.creativeType ?? null,
      name: entity.label ?? entity.externalId,
    })
    byTag.set(creative.tag, creative)
    byId.set(creative.id, creative)
    creativesAdded += 1
    return creative
  }

  const stored = (entity: EntitySetup, creative: repo.CreativeRecord | null): repo.StoredEntity => {
    const { campaignTag: _tag, creativeType: _type, ...rest } = entity
    return { ...rest, campaignTag: creative?.tag ?? '', creativeId: creative?.id ?? null }
  }

  const creatives = wanted.filter((entity) => entity.level === 'creative')
  const others = wanted.filter((entity) => entity.level !== 'creative')
  const entities: repo.StoredEntity[] = []

  for (const entity of creatives) {
    const tag = entity.campaignTag
    if (tag === '') {
      entities.push(stored(entity, null))
    } else if (tag === undefined) {
      const kept = reuse.get(entityKey(entity))
      const creative =
        (kept === undefined ? undefined : byId.get(kept)) ?? (await create(null, entity))
      entities.push(stored(entity, creative))
    } else {
      entities.push(stored(entity, byTag.get(tag) ?? (await create(tag, entity))))
    }
  }

  for (const entity of others) {
    const tag = entity.campaignTag
    if (tag === undefined || tag === '') {
      entities.push(stored(entity, null))
      continue
    }
    const creative = byTag.get(tag)
    if (!creative) {
      throw new InvalidSetupError(
        `${sourceId} ${entity.level} ${entity.externalId} names creative tag '${tag}', which the campaign has no creative for`,
      )
    }
    entities.push(stored(entity, creative))
  }

  return { entities, creativesAdded }
}

// --- the ids another platform must be told ----------------------------------------------------

/** A derived id, with whether the campaign already has it as a platform id of that source. */
export interface ExternalIdView extends DerivedExternalId {
  source: string
  linked: boolean
}

/**
 * What each platform that derives its ids (connector capability `deriveExternalIds`) wants to be
 * given for this campaign: the hand-off list a person reads to ATK today, and provisioning will
 * send tomorrow. Derived from the campaign's reference, its creatives and what the other platforms
 * created for it, so it fills in as provisioning progresses; `linked` says which of them the
 * campaign's links already carry.
 */
export async function describeExternalIds(
  deps: CampaignDeps,
  campaign: repo.CampaignDetail,
): Promise<ExternalIdView[]> {
  const derivers = deps.registry
    .ids()
    .map((id) => deps.registry.get(id))
    .filter(derivesExternalIds)
  if (derivers.length === 0) return []

  const resources = await repo.listProvisionedResources(deps.db, campaign.id)
  const input: ExternalIdInput = {
    campaign: { id: campaign.id, name: campaign.name, externalRef: campaign.externalRef },
    creatives: campaign.creatives.map((c) => ({
      id: c.id,
      tag: c.tag,
      type: c.type,
      name: c.name,
    })),
    resources,
  }
  const linked = new Set(
    campaign.links.flatMap((link) =>
      link.entities.map((e) => `${link.source}/${e.level}/${e.externalId}`),
    ),
  )
  return derivers.flatMap((connector) =>
    connector.deriveExternalIds(input).map((derived) => ({
      source: connector.id,
      ...derived,
      linked: linked.has(`${connector.id}/${derived.level}/${derived.externalId}`),
    })),
  )
}

// --- what provisioning asks of the setup --------------------------------------------------------

/** One campaign with its creatives and links, or a 404. */
export async function findCampaignDetail(
  deps: CampaignDeps,
  campaignId: string,
): Promise<repo.CampaignDetail> {
  const campaign = await repo.getCampaign(deps.db, campaignId)
  if (!campaign) throw new CampaignNotFoundError(`campaign ${campaignId} does not exist`)
  return campaign
}

/**
 * One creative per creative type the CRM named, for a campaign that has none yet for that type:
 * what provisioning creates on the platforms. Idempotent: a type that already has a creative is
 * skipped, a type that went away changes nothing (a creative is never deleted). Returns every
 * creative of the campaign, in setup order.
 */
export async function ensureCreativesForTypes(
  deps: CampaignDeps,
  campaignId: string,
): Promise<repo.CreativeRecord[]> {
  return deps.db.withTransaction(async (tx) => {
    const campaign = await repo.findCampaignForUpdate(tx, campaignId)
    if (!campaign) throw new CampaignNotFoundError(`campaign ${campaignId} does not exist`)
    const existing = await repo.listCreatives(tx, campaignId)
    const typesCovered = new Set(existing.map((c) => c.type).filter((t) => t !== null))
    for (const type of campaign.creativeTypes) {
      if (typesCovered.has(type)) continue
      await repo.insertCreative(tx, { campaignId, tag: null, type, name: type })
      typesCovered.add(type)
    }
    return repo.listCreatives(tx, campaignId)
  })
}

/**
 * Adds platform ids to a campaign the way a push does: the link is created if missing, ids it
 * does not have are added, nothing is changed or removed. For provisioning, which obtains ids one
 * creative at a time and must never rebuild a link.
 */
export async function addPlatformIds(
  deps: CampaignDeps,
  campaignId: string,
  setup: SourceSetup,
): Promise<LinkResult> {
  const [source] = checkSources(deps.registry, [setup])
  if (!source) throw new Error('checkSources returned nothing for one source')
  const result = await translatingConflicts(() =>
    deps.db.withTransaction(async (tx) => {
      const campaign = await repo.findCampaignForUpdate(tx, campaignId)
      if (!campaign) throw new CampaignNotFoundError(`campaign ${campaignId} does not exist`)
      const link = await applySource(tx, campaignId, source)
      await settleHeadline(tx, campaign)
      return link
    }),
  )
  deps.log.info(
    { campaignId, source: source.source, entitiesAdded: result.entitiesAdded },
    'platform ids added',
  )
  return result
}

// --- platform ids, set by a person ------------------------------------------------------------

export interface PlatformChange {
  /**
   * created: the campaign had no link for this platform. added: new ids joined the link.
   * updated: only labels changed. replaced: the link had no analytics yet and was rebuilt from
   * the request. unchanged: nothing to do.
   */
  outcome: 'created' | 'added' | 'updated' | 'replaced' | 'unchanged'
  campaign: repo.CampaignRecord
}

export const PLATFORM_OUTCOMES = ['created', 'added', 'updated', 'replaced', 'unchanged'] as const

/**
 * Sets one platform's ids on a campaign: PUT /campaigns/:id/platforms/:source. The request is the
 * whole list for that link. Ids it adds are always taken, like a push would, and a label — the
 * name a report prints, not part of any row's key — may change at any time. Anything else it
 * changes or leaves out — a wrong Zeus campaign id, the other kind of id, a creative that is not
 * ours, a tag — is only allowed while the link has written no analytics rows and no sync run is
 * fetching with it, and then the link is rebuilt from the request, so no sync state claims days
 * for the old ids.
 */
export async function setPlatformIds(
  deps: CampaignDeps,
  campaignId: string,
  setup: SourceSetup,
): Promise<PlatformChange> {
  const [source] = checkSources(deps.registry, [setup])
  if (!source) throw new Error('checkSources returned nothing for one source')

  const result = await translatingConflicts(() =>
    deps.db.withTransaction(async (tx) => {
      // Campaign first, then its link: the order a push takes too.
      const campaign = await repo.findCampaignForUpdate(tx, campaignId)
      if (!campaign) throw new CampaignNotFoundError(`campaign ${campaignId} does not exist`)

      const link = await repo.findLink(tx, campaignId, source.source, source.language)
      let outcome: PlatformChange['outcome']
      if (!link) {
        await applySource(tx, campaignId, source)
        outcome = 'created'
      } else {
        const current = await repo.listLinkEntities(tx, link.id)
        const credentialId =
          source.credential === undefined
            ? link.credentialId
            : await resolveCredential(tx, source.source, source.credential)
        const onlyAdds =
          keepsEvery(current, source.entities) &&
          sameJson(link.config, source.config) &&
          credentialId === link.credentialId
        if (onlyAdds) {
          const applied = await applySource(tx, campaignId, source)
          const relabelled = await repo.updateEntityLabels(tx, link.id, source.entities)
          // The name a report prints is the creative's: it follows its own entity's label.
          if (relabelled > 0) await repo.updateCreativeNames(tx, link.id)
          outcome = applied.entitiesAdded > 0 ? 'added' : relabelled > 0 ? 'updated' : 'unchanged'
        } else {
          await assertIdsChangeable(tx, {
            id: link.id,
            campaignId,
            sourceId: source.source,
            language: source.language,
          })
          // The ids that come back keep their creatives: a creative outlives its link.
          const reuse = new Map(
            current.flatMap((have) =>
              have.creativeId === null ? [] : [[entityKey(have), have.creativeId] as const],
            ),
          )
          await repo.deleteLink(tx, link.id)
          await applySource(tx, campaignId, source, reuse)
          outcome = 'replaced'
        }
      }
      return { outcome, campaign: await settleHeadline(tx, campaign) }
    }),
  )

  deps.log.info(
    { campaignId, source: source.source, language: source.language, outcome: result.outcome },
    'platform ids set',
  )
  return result
}

/**
 * Takes a platform off a campaign: DELETE /campaigns/:id/platforms/:source. The same rule as a
 * change: only while that platform has written no analytics for the campaign.
 */
export async function removePlatform(
  deps: CampaignDeps,
  campaignId: string,
  sourceId: string,
  language: string,
): Promise<repo.CampaignRecord> {
  const campaign = await deps.db.withTransaction(async (tx) => {
    const current = await repo.findCampaignForUpdate(tx, campaignId)
    if (!current) throw new CampaignNotFoundError(`campaign ${campaignId} does not exist`)
    const link = await repo.findLink(tx, campaignId, sourceId, language)
    if (!link) {
      throw new PlatformNotFoundError(
        `campaign ${campaignId} has no ${sourceId} ids${language === '' ? '' : ` for language '${language}'`}`,
      )
    }
    await assertIdsChangeable(tx, { id: link.id, campaignId, sourceId, language })
    await repo.deleteLink(tx, link.id)
    return settleHeadline(tx, current)
  })
  deps.log.info({ campaignId, source: sourceId, language }, 'platform removed')
  return campaign
}

/**
 * Every id the link has is still in the request, unchanged in role and tag. The label is not
 * identity: a request may rename an entity without rebuilding the link. A request that says
 * nothing about a creative's tag keeps the one it has: the tag of a creative we created is ours,
 * not something the caller repeats.
 */
function keepsEvery(
  current: readonly repo.StoredEntity[],
  wanted: readonly EntitySetup[],
): boolean {
  return current.every((have) =>
    wanted.some(
      (want) =>
        want.level === have.level &&
        want.externalId === have.externalId &&
        (want.role ?? null) === (have.role ?? null) &&
        (want.campaignTag === undefined
          ? have.level === 'creative' || have.campaignTag === ''
          : want.campaignTag === have.campaignTag),
    ),
  )
}

/** jsonb hands keys back in its own order, so compare with the keys sorted. */
function sameJson(a: unknown, b: unknown): boolean {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
              .map(([key, inner]) => [key, sorted(inner)]),
          )
        : value
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

/**
 * Under the link's sync-run gate lock — the lock a run opens under — so no run can start between
 * this check and the change, and none is fetching with the old ids.
 */
async function assertIdsChangeable(
  tx: Tx,
  link: { id: string; campaignId: string; sourceId: string; language: string },
): Promise<void> {
  await tx.xactLock(`sync-run-gate:${link.id}`)
  const activity = await repo.linkActivity(tx, link)
  if (activity.running) {
    throw new PlatformSyncRunningError(
      `a ${link.sourceId} sync is running for campaign ${link.campaignId}; try again when it has finished`,
    )
  }
  if (activity.hasData) {
    throw new PlatformHasDataError(
      `campaign ${link.campaignId} already has ${link.sourceId} analytics; its ids can only be added to`,
    )
  }
}

/** After the links changed, the headline follows presets.ts headlineSource. */
async function settleHeadline(tx: Tx, campaign: repo.CampaignRecord): Promise<repo.CampaignRecord> {
  const headline = headlineSource(await repo.listLinkSources(tx, campaign.id))
  if (headline === campaign.primarySource) return campaign
  return repo.updateCampaign(tx, campaign.id, { ...campaign, primarySource: headline })
}

async function resolveCredential(
  tx: Tx,
  sourceId: string,
  wanted: string | undefined,
): Promise<string> {
  const credentials = await repo.findCredentials(tx, sourceId)
  if (wanted !== undefined) {
    const match = credentials.find((c) => c.id === wanted || c.name === wanted)
    if (!match) {
      throw new CredentialNotResolvedError(
        `${sourceId} has no enabled credential '${wanted}' (has: ${credentials.map((c) => c.name).join(', ') || 'none'})`,
      )
    }
    return match.id
  }
  const [only, ...others] = credentials
  if (!only || others.length > 0) {
    throw new CredentialNotResolvedError(
      only
        ? `${sourceId} has several credentials (${credentials.map((c) => c.name).join(', ')}); name one`
        : `${sourceId} has no enabled credential`,
    )
  }
  return only.id
}

// --- Postgres errors that are really answers ---------------------------------------------------

interface PgError {
  code?: string
  constraint?: string
  message?: string
}

const UNIQUE_VIOLATION = '23505'

/**
 * The pre-checks above answer the common cases with a useful message. These are the same rules
 * enforced by the database when two setups race past the checks, or when the event-map trigger
 * refuses a target: still a caller's 4xx, never a 500.
 */
async function translatingConflicts<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const pg = error as PgError
    if (pg.code === UNIQUE_VIOLATION && pg.constraint?.startsWith('link_entity')) {
      throw new EntityInUseError(
        'a platform id in this setup already belongs to another campaign',
        {
          cause: error,
        },
      )
    }
    if (pg.code === UNIQUE_VIOLATION) {
      throw new SetupConflictError('another setup for the same record ran at the same time', {
        cause: error,
      })
    }
    if (
      typeof pg.message === 'string' &&
      (pg.message.startsWith('event_map:') || pg.message.startsWith('link_entity:'))
    ) {
      throw new InvalidSetupError(pg.message, { cause: error })
    }
    throw error
  }
}
