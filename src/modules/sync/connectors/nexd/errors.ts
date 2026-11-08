import { ConnectorContractError, ProvisionError, VerificationError } from '../../errors.ts'

export class NexdContractError extends ConnectorContractError {
  override readonly name = 'NexdContractError'
}

export class NexdVerificationError extends VerificationError {
  override readonly name = 'NexdVerificationError'
}

/** Creating or publishing on NEXD did not go as the API documents, or not in time. */
export class NexdProvisionError extends ProvisionError {
  override readonly name = 'NexdProvisionError'
}
