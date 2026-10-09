/**
 * The shape every failure in this service carries: a stable machine `code`, whether a retry could
 * help, and the status the route layer answers with. Modules subclass it — `SyncError`
 * (src/modules/sync/errors.ts) and `WebhookError` (src/modules/webhooks/errors.ts) — and the root error handler
 * and `classifySyncError` both work off this base, so a new module needs no new branch.
 *
 * A status >= 500 means "our side or upstream", never a caller mistake; the route layer never
 * echoes the message of one.
 */
export class AppError extends Error {
  override readonly name: string = 'AppError'
  readonly code: string = 'error'
  readonly retryable: boolean = false
  readonly status: number = 500
}
