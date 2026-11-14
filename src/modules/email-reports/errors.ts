import { AppError } from '../../core/errors.ts'

// Our own refusals, with the status the routes answer with. An email the provider refuses or cannot
// take now is not an error here: it is an attempt outcome recorded on the delivery row, retried on
// the ladder (deliver.ts).

export class EmailReportError extends AppError {
  override readonly name: string = 'EmailReportError'
  override readonly code: string = 'email_report_error'
}

export class EmailReportNotFoundError extends EmailReportError {
  override readonly name = 'EmailReportNotFoundError'
  override readonly code = 'email_report_not_found'
  override readonly status = 404
}

export class EmailReportDisabledError extends EmailReportError {
  override readonly name = 'EmailReportDisabledError'
  override readonly code = 'email_report_disabled'
  override readonly status = 409
}

/**
 * A report that could never work as configured: an unknown company, a campaign of another one, a
 * schedule that never fires, a recipient that is not an address, settings its kind cannot use.
 */
export class InvalidEmailReportError extends EmailReportError {
  override readonly name = 'InvalidEmailReportError'
  override readonly code = 'invalid_email_report'
  override readonly status = 422
}

/** No campaign has a number in the period, so there is nothing to send (the schedule skips it). */
export class EmptyEmailPeriodError extends EmailReportError {
  override readonly name = 'EmptyEmailPeriodError'
  override readonly code = 'empty_period'
  override readonly status = 409
}
