import { AppError } from '../../core/errors.ts'

// Refusals of the public page tracker. Anyone on the internet can post to it, so a message names
// fields and never repeats what was sent.

export class TrackingError extends AppError {
  override readonly name: string = 'TrackingError'
  override readonly code: string = 'tracking_error'
}

/** The body is not JSON, not an object, or a field has the wrong type or form. */
export class InvalidEventError extends TrackingError {
  override readonly name = 'InvalidEventError'
  override readonly code = 'invalid_event'
  override readonly status = 400

  /** Field names; '' is the body itself. */
  readonly paths: string[]

  constructor(paths: string[]) {
    const fields = paths.filter((path) => path !== '')
    super(fields.length === 0 ? 'invalid body' : `invalid fields: ${fields.join(', ')}`)
    this.paths = paths
  }
}

/** No such campaign, or it is archived: nothing is counted for it. */
export class UnknownCampaignError extends TrackingError {
  override readonly name = 'UnknownCampaignError'
  override readonly code = 'unknown_campaign'
  override readonly status = 404

  constructor() {
    super('no such campaign')
  }
}
