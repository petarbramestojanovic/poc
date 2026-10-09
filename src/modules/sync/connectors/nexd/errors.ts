import { ConnectorContractError, VerificationError } from '../../errors.ts'

export class NexdContractError extends ConnectorContractError {
  override readonly name = 'NexdContractError'
}

export class NexdVerificationError extends VerificationError {
  override readonly name = 'NexdVerificationError'
}
