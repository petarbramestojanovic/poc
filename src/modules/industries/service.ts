import type { Db, Queryable } from '../../core/db.ts'
import type { HttpClient } from '../../core/http/HttpClient.ts'
import type { Logger } from '../../core/log.ts'
import type { RunTracker } from '../sync/engine.ts'
import { CampaignNotFoundError, IndustryMapMismatchError } from './errors.ts'
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

export interface IndustryDeps {
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
