import type { Db, Queryable } from '../../core/db.ts'
import type { HttpClient } from '../../core/http/HttpClient.ts'
import type { Logger } from '../../core/log.ts'
import type { RunTracker } from '../sync/engine.ts'
import { CampaignNotFoundError, IndustryMapMismatchError, UnknownIndustryError } from './errors.ts'
import { askIndustry, FALLBACK_INDUSTRY } from './llm.ts'
import { INDUSTRY_MAP, mapIndustry } from './map.ts'
import * as repo from './repo.ts'

// Classifying a campaign's industry after it exists: the keyword table first, then the LLM. The
// Salesforce push hands every campaign without an industry here, in the background (./trigger.ts),
// and `npm run industries -- backfill` runs it over the campaigns that already exist.
//
// Once set, an industry never changes on its own: the write is one guarded UPDATE that only lands
// while the campaign has none, so a value a person set in the meantime always wins. The LLM call
// happens before it, outside any transaction, holding no lock and no connection.

/**
 * The service's share of the pool for classification. A push of 200 opportunities can hand over
 * 200 campaigns at once, each a few single statements: one connection keeps them from taking the
 * pool from the sync and the webhook tick. The LLM calls queue on their own (one per credential).
 */
export const INDUSTRY_MAX_CONNECTIONS = 1

export interface IndustryDeps {
  /** In the service, limited to INDUSTRY_MAX_CONNECTIONS (limitDb). */
  db: Db
  /** Its own client: 15 s per attempt, 2 retries. */
  http: HttpClient
  log: Logger
  /** OpenRouter's key. Unset = keyword table only: unknown brands stay unclassified. */
  apiKey?: string
  signal?: AbortSignal
  tracker?: RunTracker
}

export interface ClassifyOutcome {
  campaignId: string
  /** set = written now; kept = it already had one; unresolved = nothing decided, nothing written. */
  outcome: 'set' | 'kept' | 'unresolved'
  /** What the campaign has after this: the new value, the one it kept, or still its old one. */
  industry: string | null
  /** Who decided it this time; null unless `set`. */
  via: 'map' | 'llm' | null
}

export interface ClassifyOptions {
  /**
   * Redo what the keyword table or the LLM decided (the backfill after the table changed). A value
   * a person set is still kept.
   */
  reclassify?: boolean
}

export async function classifyCampaign(
  deps: IndustryDeps,
  campaignId: string,
  options: ClassifyOptions = {},
): Promise<ClassifyOutcome> {
  const campaign = await repo.loadForClassification(deps.db, campaignId)
  if (!campaign) throw new CampaignNotFoundError(`campaign ${campaignId} does not exist`)

  const reclassify = options.reclassify === true
  if (campaign.industry !== null && (!reclassify || campaign.industrySource === 'manual')) {
    return { campaignId, outcome: 'kept', industry: campaign.industry, via: null }
  }

  const decided = await decide(deps, campaign)
  if (!decided) {
    return { campaignId, outcome: 'unresolved', industry: campaign.industry, via: null }
  }

  const write = reclassify ? repo.setIndustryUnlessManual : repo.setIndustryIfEmpty
  if (await write(deps.db, campaignId, decided.industry, decided.via)) {
    return { campaignId, outcome: 'set', industry: decided.industry, via: decided.via }
  }
  // Someone set it while the LLM was thinking (or, reclassifying, the answer was what it had).
  const now = await repo.loadForClassification(deps.db, campaignId)
  if (!now) throw new CampaignNotFoundError(`campaign ${campaignId} does not exist`)
  return { campaignId, outcome: 'kept', industry: now.industry, via: null }
}

async function decide(
  deps: IndustryDeps,
  campaign: repo.ClassificationSubject,
): Promise<{ industry: string; via: 'map' | 'llm' } | null> {
  const mapped = mapIndustry(campaign.companyName, campaign.name)
  if (mapped !== null) return { industry: mapped, via: 'map' }
  if (deps.apiKey === undefined) return null

  const asked = await askIndustry(
    {
      http: deps.http,
      apiKey: deps.apiKey,
      log: deps.log.child({ campaignId: campaign.id }),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    await repo.listIndustries(deps.db),
    { campaignName: campaign.name, companyName: campaign.companyName, country: campaign.country },
  )
  return asked === null ? null : { industry: asked, via: 'llm' }
}

/**
 * Fails when the keyword table (or the LLM's fallback) names an industry app.industry does not
 * have. Called at boot, so a bad table stops the deploy instead of making the foreign key refuse a
 * campaign at push time.
 */
export async function verifyIndustryMap(db: Queryable): Promise<void> {
  const known = new Set((await repo.listIndustries(db)).map((industry) => industry.name))
  const named = new Set([...INDUSTRY_MAP.map((entry) => entry.industry), FALLBACK_INDUSTRY])
  const missing = [...named].filter((name) => !known.has(name))
  if (missing.length > 0) {
    throw new IndustryMapMismatchError(
      `the keyword table names industries app.industry does not have: ${missing.join(', ')}`,
    )
  }
}

const FK_VIOLATION = '23503'

/**
 * A person sets the campaign's industry (source 'manual'), or clears it with null. A value set by
 * hand is never overwritten by the classifier; a cleared one is classified again by the next push
 * or the backfill. One UPDATE.
 */
export async function setIndustryByHand(
  db: Queryable,
  campaignId: string,
  industry: string | null,
): Promise<repo.IndustryAssignment> {
  let assigned: repo.IndustryAssignment | undefined
  try {
    assigned = await repo.setIndustryManual(db, campaignId, industry)
  } catch (error) {
    const pg = error as { code?: unknown; constraint?: unknown }
    if (pg.code === FK_VIOLATION && pg.constraint === 'campaign_industry_fkey') {
      // The path, never the value.
      throw new UnknownIndustryError('industry is not one of GET /industries', { cause: error })
    }
    throw error
  }
  if (!assigned) throw new CampaignNotFoundError(`campaign ${campaignId} does not exist`)
  return assigned
}
