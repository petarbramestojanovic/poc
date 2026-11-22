import type { LinkEntity } from '../../types.ts'

// Whose row is it? Zeus's devices and tracker reports are downloaded once for the whole account
// (connector.ts), so each link picks its own rows out of them here. Pure: no I/O.
//
// The rule (confirmed with the product owner, 2026-11-22): a row belongs to the creative whose id
// it carries in `external_id`. ATK sets that to the strings handoff.ts derives, so a provisioned
// link needs nothing mapped by hand. Ids are compared as whole strings: nothing here knows their
// format.
//
// Zeus repeats its own number in `external_id` where nobody set one. That number is from another
// namespace (a campaign number, a pixel number), so it never names a creative.

/** What says whose a device row is. */
export interface DeviceRowIds {
  campaign_id: string
  external_id?: string | null | undefined
}

/** What says whose a tracker row is, and what its pixel counts. */
export interface TrackerRowIds {
  pixel_id: string
  external_id?: string | null | undefined
  code?: string | null | undefined
}

export const ZEUS_PIXEL_ROLES = ['engagement', 'finish'] as const
export type PixelRole = (typeof ZEUS_PIXEL_ROLES)[number]

/**
 * What a pixel counts, by the `code` ATK gives it. A code is a role shared by every campaign on
 * the account, never an identity. A role without a code here (finish) has no agreed code yet: such
 * a pixel is queued as unmapped until a person maps it by hand, never guessed.
 */
export const ZEUS_PIXEL_ROLE_BY_CODE: ReadonlyMap<string, PixelRole> = new Map([
  ['eng', 'engagement'],
])

/** The id a Zeus thing goes by in a report: the external id somebody set, else Zeus's own number. */
export function reportedId(externalId: string | null | undefined, zeusId: string): string {
  return externalId === null || externalId === undefined || externalId === '' ? zeusId : externalId
}

/** The external id somebody gave a Zeus thing; undefined where Zeus only repeats its own number. */
function assignedExternalId(
  externalId: string | null | undefined,
  zeusId: string,
): string | undefined {
  const id = reportedId(externalId, zeusId)
  return id === zeusId ? undefined : id
}

function creativeNamed(
  entities: readonly LinkEntity[],
  externalId: string | undefined,
): LinkEntity | undefined {
  if (externalId === undefined) return undefined
  return entities.find((e) => e.level === 'creative' && e.externalId === externalId)
}

/**
 * The link's campaign as Zeus's own report names it: its Zeus number and the id it goes by. A
 * device row is the campaign's only when it carries both, which is what tells the campaign's own
 * row from a row Zeus breaks out of it for one creative.
 */
export interface CampaignIdentity {
  zeusId: string
  reportedId: string
}

/** Read from the link's own `/reports/campaigns` rows, which were asked for by the id it typed. */
export function campaignIdentities(rows: readonly DeviceRowIds[]): CampaignIdentity[] {
  const identities = new Map<string, CampaignIdentity>()
  for (const row of rows) {
    const identity = {
      zeusId: row.campaign_id,
      reportedId: reportedId(row.external_id, row.campaign_id),
    }
    identities.set(`${identity.zeusId}|${identity.reportedId}`, identity)
  }
  return [...identities.values()]
}

export type DeviceMatch =
  /** The row is this entity's: a creative of the link, or the link's campaign. */
  | { kind: 'owned'; entity: LinkEntity }
  /** Inside the link's campaign, but neither the campaign's own row nor a listed creative's. */
  | { kind: 'unlinked'; owner: string }
  /** Another campaign's row. */
  | { kind: 'not_ours' }

/**
 * What a device row is to this link: the creative its external id names; else the campaign's own
 * row, when it carries the campaign's two ids; else, inside our campaign, a row for something the
 * link does not list (a creative nobody linked), which is not the campaign's and must not be added
 * to it; else another campaign's.
 */
export function matchDeviceRow(
  row: DeviceRowIds,
  entities: readonly LinkEntity[],
  identities: readonly CampaignIdentity[],
): DeviceMatch {
  const creative = creativeNamed(entities, assignedExternalId(row.external_id, row.campaign_id))
  if (creative) return { kind: 'owned', entity: creative }

  const campaign = entities.find((e) => e.level === 'campaign')
  const inOurCampaign = identities.filter((identity) => identity.zeusId === row.campaign_id)
  if (!campaign || inOurCampaign.length === 0) return { kind: 'not_ours' }

  const owner = reportedId(row.external_id, row.campaign_id)
  return inOurCampaign.some((identity) => identity.reportedId === owner)
    ? { kind: 'owned', entity: campaign }
    : { kind: 'unlinked', owner }
}

export type TrackerMatch =
  /** The pixel's fires count as `role` on the entity's creative (or the campaign's own row). */
  | { kind: 'counted'; entity: LinkEntity; role: PixelRole }
  /** One of ours, but nothing says what it counts: the link's "map this" queue, under `label`. */
  | { kind: 'unmapped'; label: string }
  /** Another campaign's pixel. */
  | { kind: 'not_ours' }

const isPixelRole = (role: string | null): role is PixelRole =>
  (ZEUS_PIXEL_ROLES as readonly string[]).includes(role ?? '')

/**
 * What a tracker row is to this link.
 *
 * 1. A pixel a person mapped by hand (a `pixel` entity) is named by Zeus's pixel number, the one
 *    id no two pixels share, and counts as the role the person gave it. Never by `code` (`eng` is
 *    on every campaign's pixel) and never by external id (the pixels of one creative share it).
 *    What a person said about one pixel stands, so this comes first.
 * 2. Otherwise a pixel that carries the id of one of the link's creatives counts for it, as the
 *    role its `code` stands for; a code without a role is queued, not guessed. Creatives only: a
 *    pixel carrying the campaign's id would put its fires on the campaign's own row, beside the
 *    creatives' and added to them by every campaign-level read.
 * 3. Otherwise it is another campaign's.
 */
export function resolveTrackerRow(
  row: TrackerRowIds,
  entities: readonly LinkEntity[],
): TrackerMatch {
  const mapped = entities.find((e) => e.level === 'pixel' && e.externalId === row.pixel_id)
  if (mapped) {
    return isPixelRole(mapped.role)
      ? { kind: 'counted', entity: mapped, role: mapped.role }
      : {
          kind: 'unmapped',
          label: `pixel ${row.pixel_id} mapped by hand with role "${mapped.role ?? ''}"`,
        }
  }

  const creative = creativeNamed(entities, assignedExternalId(row.external_id, row.pixel_id))
  if (!creative) return { kind: 'not_ours' }
  const role = row.code ? ZEUS_PIXEL_ROLE_BY_CODE.get(row.code) : undefined
  if (role) return { kind: 'counted', entity: creative, role }
  const code = row.code ? `code "${row.code}"` : 'no code'
  return { kind: 'unmapped', label: `pixel ${row.pixel_id} with ${code} on ${creative.externalId}` }
}
