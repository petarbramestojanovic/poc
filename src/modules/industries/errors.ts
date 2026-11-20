import { AppError } from '../../core/errors.ts'

// Refusals of the industries module, with the status the admin routes answer. Messages carry field
// paths and ids, never a campaign's or company's name.

export class IndustryError extends AppError {
  override readonly name: string = 'IndustryError'
  override readonly code: string = 'industry_error'
}

/**
 * The campaign does not exist. The same code as the campaigns module's refusal, so a client sees
 * one answer for a missing campaign whichever route it called; its own class, since this module
 * imports nothing from campaigns.
 */
export class CampaignNotFoundError extends IndustryError {
  override readonly name = 'CampaignNotFoundError'
  override readonly code = 'campaign_not_found'
  override readonly status = 404
}

/** The name is not one of app.industry (GET /industries lists them). Nobody creates one here. */
export class UnknownIndustryError extends IndustryError {
  override readonly name = 'UnknownIndustryError'
  override readonly code = 'unknown_industry'
  override readonly status = 400
}

/** The keyword table names an industry app.industry does not have. Fails the boot. */
export class IndustryMapMismatchError extends IndustryError {
  override readonly name = 'IndustryMapMismatchError'
  override readonly code = 'industry_map_mismatch'
}
