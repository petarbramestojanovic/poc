import {
  DeadlineExceededError,
  HttpError,
  isRetryableStatus,
  NetworkError,
  ResponseBodyError,
  ResponseTooLargeError,
  RetryBudgetExhaustedError,
} from '../http/HttpClient.ts'
import { AppError } from '../errors.ts'

// Every failure a sync run can end in carries a stable machine code, whether retrying could
// help, and the HTTP status the trigger route should answer with. The route (step 9) maps
// errors through `classifySyncError` only; the scheduler asks it whether to retry.

export class SyncError extends AppError {
  override readonly name: string = 'SyncError'
  override readonly code: string = 'sync_error'
}

export class LinkNotFoundError extends SyncError {
  override readonly name = 'LinkNotFoundError'
  override readonly code = 'link_not_found'
  override readonly status = 404
}

export class SyncRunNotFoundError extends SyncError {
  override readonly name = 'SyncRunNotFoundError'
  override readonly code = 'sync_run_not_found'
  override readonly status = 404
}

export class LinkDisabledError extends SyncError {
  override readonly name = 'LinkDisabledError'
  override readonly code = 'link_disabled'
  override readonly status = 409
}

export class TooSoonError extends SyncError {
  override readonly name = 'TooSoonError'
  override readonly code = 'too_soon'
  override readonly status = 429
  override readonly retryable = true
  readonly retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class RunInProgressError extends SyncError {
  override readonly name = 'RunInProgressError'
  override readonly code = 'run_in_progress'
  override readonly status = 409
  override readonly retryable = true
}

export interface ConfigIssue {
  path: string
  message: string
}

export class InvalidLinkConfigError extends SyncError {
  override readonly name = 'InvalidLinkConfigError'
  override readonly code = 'invalid_link_config'
  override readonly status = 422
  /** Field paths and messages only — never the config values themselves. */
  readonly issues: ConfigIssue[]
  constructor(message: string, issues: ConfigIssue[]) {
    super(message)
    this.issues = issues
  }
}

/** A requested window with no complete day in it yet: nothing could be synced, or trusted. */
export class WindowNotCompleteError extends SyncError {
  override readonly name = 'WindowNotCompleteError'
  override readonly code = 'window_not_complete'
  override readonly status = 422
}

export class UnknownTargetError extends SyncError {
  override readonly name = 'UnknownTargetError'
  override readonly code = 'unknown_target'
  override readonly status = 422
}

export class UnknownSourceError extends SyncError {
  override readonly name = 'UnknownSourceError'
  override readonly code = 'unknown_source'
  constructor(sourceId: string, known: readonly string[]) {
    super(`No connector registered for source '${sourceId}' (known: ${known.join(', ')})`)
  }
}

export class RegistryMismatchError extends SyncError {
  override readonly name = 'RegistryMismatchError'
  override readonly code = 'registry_mismatch'
}

export class CredentialUnavailableError extends SyncError {
  override readonly name = 'CredentialUnavailableError'
  override readonly code = 'credential_unavailable'
}

/** The platform answered with something that breaks the contract we built the mapper on. */
export class ConnectorContractError extends SyncError {
  override readonly name: string = 'ConnectorContractError'
  override readonly code: string = 'contract_violation'
  override readonly status: number = 502
}

/** The platform's numbers are internally inconsistent or do not add up to its own totals. */
export class VerificationError extends SyncError {
  override readonly name: string = 'VerificationError'
  override readonly code: string = 'verification_failed'
  override readonly status: number = 502
}

export class RowOutOfWindowError extends ConnectorContractError {
  override readonly name = 'RowOutOfWindowError'
  override readonly code = 'row_out_of_window'
}

export class InvalidRowDateError extends ConnectorContractError {
  override readonly name = 'InvalidRowDateError'
  override readonly code = 'invalid_row_date'
}

export class SyncAbortedError extends SyncError {
  override readonly name = 'SyncAbortedError'
  override readonly code = 'aborted'
  override readonly status = 503
  override readonly retryable = true
}

export interface ErrorClassification {
  code: string
  retryable: boolean
  status: number
}

/** Also classifies webhook errors: both share the AppError base. */
export function classifySyncError(error: unknown): ErrorClassification {
  if (error instanceof AppError) {
    return { code: error.code, retryable: error.retryable, status: error.status }
  }
  if (error instanceof HttpError) {
    return { code: 'upstream_http', retryable: isRetryableStatus(error.status), status: 502 }
  }
  if (error instanceof NetworkError) {
    return { code: 'upstream_network', retryable: error.retryable, status: 502 }
  }
  if (error instanceof RetryBudgetExhaustedError || error instanceof DeadlineExceededError) {
    return { code: 'upstream_retry_budget', retryable: true, status: 503 }
  }
  if (error instanceof ResponseTooLargeError) {
    return { code: 'upstream_too_large', retryable: false, status: 502 }
  }
  if (error instanceof ResponseBodyError) {
    return { code: 'upstream_bad_body', retryable: false, status: 502 }
  }
  return { code: 'internal', retryable: false, status: 500 }
}
