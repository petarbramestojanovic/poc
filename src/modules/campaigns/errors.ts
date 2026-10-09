import { AppError } from '../../core/errors.ts'

// Refusals of the campaign setup service, with the status the admin and inbound routes answer.
// A 4xx here is always something the caller can fix by changing what it sent. Refusals about
// the company itself are in companies/errors.ts.

export class CampaignSetupError extends AppError {
  override readonly name: string = 'CampaignSetupError'
  override readonly code: string = 'campaign_setup_error'
}

export class CampaignNotFoundError extends CampaignSetupError {
  override readonly name = 'CampaignNotFoundError'
  override readonly code = 'campaign_not_found'
  override readonly status = 404
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

/** The campaign has no link for this platform (and language), so there is nothing to change. */
export class PlatformNotFoundError extends CampaignSetupError {
  override readonly name = 'PlatformNotFoundError'
  override readonly code = 'platform_not_found'
  override readonly status = 404
}

/**
 * Changing or removing a platform id once rows were written with it would leave those rows
 * attributed to the wrong ids. Adding ids is always allowed; this refuses everything else.
 */
export class PlatformHasDataError extends CampaignSetupError {
  override readonly name = 'PlatformHasDataError'
  override readonly code = 'platform_has_data'
  override readonly status = 409
}

/** A sync run is fetching with the current ids; changing them now would race its write. */
export class PlatformSyncRunningError extends CampaignSetupError {
  override readonly name = 'PlatformSyncRunningError'
  override readonly code = 'sync_in_progress'
  override readonly status = 409
  override readonly retryable = true
}
