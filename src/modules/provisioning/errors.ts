import { AppError } from '../../core/errors.ts'

// Our own refusals around a provisioning run. What a platform did wrong is a ProvisionError
// (src/modules/sync/errors.ts), raised by its connector.

export class ProvisioningError extends AppError {
  override readonly name: string = 'ProvisioningError'
  override readonly code: string = 'provisioning_error'
}

/** Another run is creating this campaign's things right now; two would create them twice. */
export class ProvisioningInProgressError extends ProvisioningError {
  override readonly name = 'ProvisioningInProgressError'
  override readonly code = 'provisioning_in_progress'
  override readonly status = 409
}

/** No connector can create anything, or the campaign has nothing to create (no creative type). */
export class NothingToProvisionError extends ProvisioningError {
  override readonly name = 'NothingToProvisionError'
  override readonly code = 'nothing_to_provision'
  override readonly status = 422
}
