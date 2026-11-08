import type { DerivedExternalId, ExternalIdInput } from '../../types.ts'

// The ids ATK sets as `external_id` on a Zeus campaign and its creatives, in the format agreed
// with ATK on 2026-11-03:
//
//   campaign   SF-<Opportunity Id>_nexd-<NEXD campaign id>
//   creative   SF-<Opportunity Id>_nexd-<NEXD campaign id>_nexd-<NEXD creative id>
//
// so a Zeus report row comes back naming our own key. The strings are data on one Zeus entity,
// derived here from the CRM reference and the builder's ids (external.provisioned_resource), and
// nothing in `app` depends on their shape: a new builder means a new format agreed with ATK then,
// and a change to this file. Pure: no I/O, derives what it can, leaves out what it cannot yet.

/** The builder whose ids the agreed format carries. */
export const ZEUS_ID_BUILDER = 'nexd'

/** The CRM prefix ATK knows; another system's reference is prefixed with its own name. */
const CRM_PREFIXES: Readonly<Record<string, string>> = { salesforce: 'SF' }

export function deriveZeusExternalIds(input: ExternalIdInput): DerivedExternalId[] {
  const ref = input.campaign.externalRef
  const builderCampaign = input.resources.find(
    (r) => r.source === ZEUS_ID_BUILDER && r.kind === 'campaign' && r.creativeId === null,
  )
  if (!ref || !builderCampaign) return []

  const prefix = CRM_PREFIXES[ref.system] ?? ref.system.toUpperCase()
  const campaignId = `${prefix}-${ref.id}_${ZEUS_ID_BUILDER}-${builderCampaign.externalId}`
  const derived: DerivedExternalId[] = [
    { level: 'campaign', creativeId: null, externalId: campaignId },
  ]

  for (const creative of input.creatives) {
    const builderCreative = input.resources.find(
      (r) => r.source === ZEUS_ID_BUILDER && r.kind === 'creative' && r.creativeId === creative.id,
    )
    if (!builderCreative) continue
    derived.push({
      level: 'creative',
      creativeId: creative.id,
      externalId: `${campaignId}_${ZEUS_ID_BUILDER}-${builderCreative.externalId}`,
    })
  }
  return derived
}
