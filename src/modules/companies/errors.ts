import { AppError } from '../../core/errors.ts'

// Refusals about a company, with the status the routes answer. A 4xx here is always something the
// caller can fix by changing what it sent.

export class CompanyError extends AppError {
  override readonly name: string = 'CompanyError'
  override readonly code: string = 'company_error'
}

/** `company.id` in a setup names a company that does not exist. */
export class CompanyNotFoundError extends CompanyError {
  override readonly name = 'CompanyNotFoundError'
  override readonly code = 'company_not_found'
  override readonly status = 422
}

/**
 * A company with this name already exists and the caller did not say it means that one. Companies
 * are the boundary a client's webhook reports across, so a name is never silently matched: the
 * caller passes the existing id, or an external reference.
 */
export class CompanyNameExistsError extends CompanyError {
  override readonly name = 'CompanyNameExistsError'
  override readonly code = 'company_name_exists'
  override readonly status = 409
}
