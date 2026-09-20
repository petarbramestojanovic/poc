import { AppError } from '../errors.ts'

// Refusals of the campaign setup service, with the status the admin routes answer. A 4xx here is
// always something the caller can fix by changing what it sent.

export class CampaignSetupError extends AppError {
  override readonly name: string = 'CampaignSetupError'
  override readonly code: string = 'campaign_setup_error'
}

export class CampaignNotFoundError extends CampaignSetupError {
  override readonly name = 'CampaignNotFoundError'
  override readonly code = 'campaign_not_found'
  override readonly status = 404
}

/** `company.id` in a setup names a company that does not exist. */
export class CompanyNotFoundError extends CampaignSetupError {
  override readonly name = 'CompanyNotFoundError'
  override readonly code = 'company_not_found'
  override readonly status = 422
}

/**
 * A company with this name already exists and the caller did not say it means that one. Companies
 * are the boundary a client's webhook reports across, so a name is never silently matched: the
 * caller passes the existing id, or an external reference.
 */
export class CompanyNameExistsError extends CampaignSetupError {
  override readonly name = 'CompanyNameExistsError'
  override readonly code = 'company_name_exists'
  override readonly status = 409
}

/** A re-push names another company than the one the campaign belongs to. Campaigns do not move. */
export class CompanyMismatchError extends CampaignSetupError {
  override readonly name = 'CompanyMismatchError'
  override readonly code = 'company_mismatch'
  override readonly status = 409
}

/** The platform id already belongs to another campaign (one external entity, one campaign). */
export class EntityInUseError extends CampaignSetupError {
  override readonly name = 'EntityInUseError'
  override readonly code = 'entity_in_use'
  override readonly status = 409
}

/** A new campaign with no source, or with several, has to say which one is the headline. */
export class PrimarySourceRequiredError extends CampaignSetupError {
  override readonly name = 'PrimarySourceRequiredError'
  override readonly code = 'primary_source_required'
  override readonly status = 422
}

/** The source is unknown, is not a platform we sync, or is switched off. */
export class UnsupportedSourceError extends CampaignSetupError {
  override readonly name = 'UnsupportedSourceError'
  override readonly code = 'unsupported_source'
  override readonly status = 422
}

/** No credential was named and the source does not have exactly one enabled credential. */
export class CredentialNotResolvedError extends CampaignSetupError {
  override readonly name = 'CredentialNotResolvedError'
  override readonly code = 'credential_not_resolved'
  override readonly status = 422
}

/** The setup contradicts what the source's connector accepts, or contradicts itself. */
export class InvalidSetupError extends CampaignSetupError {
  override readonly name = 'InvalidSetupError'
  override readonly code = 'invalid_setup'
  override readonly status = 422
}

/** Two setups for the same record collided. Nothing was written; sending it again will work. */
export class SetupConflictError extends CampaignSetupError {
  override readonly name = 'SetupConflictError'
  override readonly code = 'setup_conflict'
  override readonly status = 409
  override readonly retryable = true
}
