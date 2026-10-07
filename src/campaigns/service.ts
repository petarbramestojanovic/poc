import type { Db, Tx } from '../db.ts'
import type { Logger } from '../log.ts'
import type { ConnectorRegistry } from '../sync/registry.ts'
import {
  CampaignNotFoundError,
  CompanyMismatchError,
  CompanyNameExistsError,
  CompanyNotFoundError,
  CredentialNotResolvedError,
  EntityInUseError,
  InvalidSetupError,
  PlatformHasDataError,
  PlatformNotFoundError,
  PlatformSyncRunningError,
  SetupConflictError,
  UnsupportedSourceError,
} from './errors.ts'
import type { CampaignSetup, CompanyRef, EntitySetup, SourceSetup } from './input.ts'
import { headlineSource } from './presets.ts'
import * as repo from './repo.ts'
import { checkSources } from './validate.ts'

// The one way a campaign gets into the database. The Salesforce report (src/salesforce/) calls
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
}

export interface CampaignSetupResult {
  /** False when an `externalRef` matched a campaign that was already there. */
  created: boolean
  /** True when that existing campaign's own fields changed. */
  updated: boolean
  company: repo.CompanyRecord
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
      const known = existing ? await repo.findCompany(tx, existing.companyId) : undefined
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
      })),
    },
    result.created ? 'campaign set up' : 'campaign setup applied to an existing campaign',
  )
  return result
}

// --- company --------------------------------------------------------------------------------

async function lockCompany(tx: Tx, ref: CompanyRef): Promise<void> {
  if ('id' in ref) return
  // By reference when there is one; otherwise by name, so two people creating "Rauch" at the
  // same moment cannot both pass the name check.
  await tx.xactLock(
    ref.externalRef
      ? `company-setup:${ref.externalRef.system}:${ref.externalRef.id}`
      : `company-name:${ref.name.toLowerCase()}`,
  )
}

/**
 * `known` is the company of the campaign a push matched: a push that names that company by name
 * alone means that company, and is not refused as a duplicate name.
 */
async function resolveCompany(
  tx: Tx,
  ref: CompanyRef,
  known: repo.CompanyRecord | undefined,
): Promise<repo.CompanyRecord> {
  if ('id' in ref) {
    const company = await repo.findCompany(tx, ref.id)
    if (!company) throw new CompanyNotFoundError(`company ${ref.id} does not exist`)
    return company
  }

  if (ref.externalRef) {
    const company = await repo.findCompanyByRef(tx, ref.externalRef)
    if (!company) return repo.insertCompany(tx, ref.name, ref.externalRef)
    return company.name === ref.name ? company : repo.updateCompanyName(tx, company.id, ref.name)
  }

  if (known?.name.toLowerCase() === ref.name.toLowerCase()) return known

  // A name is never matched silently: a company is the boundary a client's webhook reports
  // across, and attaching a campaign to a namesake would leak it into another client's report.
  const namesake = await repo.findCompanyByName(tx, ref.name)
  if (namesake) {
    throw new CompanyNameExistsError(
      `a company named '${namesake.name}' already exists (${namesake.id}); pass company.id to use it`,
    )
  }
  return repo.insertCompany(tx, ref.name, undefined)
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
  }
  const unchanged = (Object.keys(next) as (keyof repo.CampaignValues)[]).every(
    (key) => JSON.stringify(next[key]) === JSON.stringify(current[key]),
  )
  if (unchanged) return { campaign: current, updated: false }
  if (next.primarySource !== current.primarySource) await assertSourceExists(tx, next.primarySource)
  return { campaign: await repo.updateCampaign(tx, current.id, next), updated: true }
}

async function assertSourceExists(tx: Tx, sourceId: string): Promise<void> {
  if (!(await repo.findSource(tx, sourceId))) {
    throw new UnsupportedSourceError(`primarySource '${sourceId}' is not a known source`)
  }
}

// --- one source: link, definitions, entities, event map --------------------------------------

async function applySource(tx: Tx, campaignId: string, source: SourceSetup): Promise<LinkResult> {
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
  const entitiesAdded = await repo.insertEntities(tx, linkId, source.source, source.entities)
  await repo.insertEventMap(tx, linkId, source.eventMap)

  return {
    id: linkId,
    source: source.source,
    language: source.language,
    created: !existing,
    entitiesAdded,
  }
}

// --- platform ids, set by a person ------------------------------------------------------------

export interface PlatformChange {
  /**
   * created: the campaign had no link for this platform. added: new ids joined the link.
   * replaced: the link had no analytics yet and was rebuilt from the request. unchanged: nothing to do.
   */
  outcome: 'created' | 'added' | 'replaced' | 'unchanged'
  campaign: repo.CampaignRecord
}

/**
 * Sets one platform's ids on a campaign: PUT /campaigns/:id/platforms/:source. The request is the
 * whole list for that link. Ids it adds are always taken, like a push would. Anything it changes
 * or leaves out — a wrong Zeus campaign id, the other kind of id, a creative that is not ours — is
 * only allowed while the link has written no analytics rows and no sync run is fetching with it,
 * and then the link is rebuilt from the request, so no sync state claims days for the old ids.
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
          outcome = applied.entitiesAdded > 0 ? 'added' : 'unchanged'
        } else {
          await assertIdsChangeable(tx, {
            id: link.id,
            campaignId,
            sourceId: source.source,
            language: source.language,
          })
          await repo.deleteLink(tx, link.id)
          await applySource(tx, campaignId, source)
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

/** Every id the link has is still in the request, unchanged in role, label and tag. */
function keepsEvery(current: readonly EntitySetup[], wanted: readonly EntitySetup[]): boolean {
  return current.every((have) =>
    wanted.some(
      (want) =>
        want.level === have.level &&
        want.externalId === have.externalId &&
        (want.role ?? null) === (have.role ?? null) &&
        (want.label ?? null) === (have.label ?? null) &&
        want.campaignTag === have.campaignTag,
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
  return repo.updateCampaign(tx, campaign.id, {
    name: campaign.name,
    primarySource: headline,
    timezone: campaign.timezone,
    languages: campaign.languages,
    startsOn: campaign.startsOn,
    endsOn: campaign.endsOn,
    status: campaign.status,
    price: campaign.price,
  })
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
    if (typeof pg.message === 'string' && pg.message.startsWith('event_map:')) {
      throw new InvalidSetupError(pg.message, { cause: error })
    }
    throw error
  }
}
