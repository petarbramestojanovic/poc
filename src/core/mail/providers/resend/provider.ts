import {
  DeadlineExceededError,
  NetworkError,
  ResponseBodyError,
  ResponseTooLargeError,
  RetryBudgetExhaustedError,
  type HttpClient,
  type HttpResponse,
} from '../../../http/HttpClient.ts'
import { MailError, MailUnavailableError } from '../../errors.ts'
import type { MailProvider } from '../../types.ts'
import { RESEND_EMAILS_URL, readResendAnswer, toResendBody, toResendHeaders } from './mapper.ts'

// The only code that talks to Resend: one POST per message through our HttpClient, which brings
// the timeout, the response size cap, redirect refusal and redacted errors. The client is built
// with no in-process retry; a caller with a delivery record retries on its own ladder, and the
// idempotency key makes that safe.

/** Requests with one key are serialised, which also keeps us far below Resend's 10 per second. */
const CREDENTIAL_KEY = 'mail:resend'

export interface ResendProviderOptions {
  apiKey: string
  http: HttpClient
  /** Tests point it elsewhere; the service never does. */
  url?: string
}

export function createResendProvider(options: ResendProviderOptions): MailProvider {
  const url = options.url ?? RESEND_EMAILS_URL
  return {
    name: 'resend',
    async send(mail, ctx) {
      let response: HttpResponse
      try {
        response = await options.http.request({
          method: 'POST',
          url,
          headers: toResendHeaders(options.apiKey, mail),
          body: toResendBody(mail),
          credentialKey: CREDENTIAL_KEY,
          log: ctx.log,
          returnErrorResponses: true,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
      } catch (error) {
        throw asUnavailable(error, ctx.signal)
      }

      let body: unknown
      try {
        body = response.json()
      } catch {
        body = undefined
      }
      const answer = readResendAnswer(response.status, body)
      if (answer instanceof MailError) throw answer
      return answer
    },
  }
}

/** No answer from Resend: the message may or may not have gone out. Aborts and bugs pass through. */
function asUnavailable(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted === true) return error
  if (
    error instanceof NetworkError ||
    error instanceof DeadlineExceededError ||
    error instanceof ResponseTooLargeError ||
    error instanceof ResponseBodyError ||
    error instanceof RetryBudgetExhaustedError
  ) {
    // These messages carry the URL (no secret in it) and a code, never the request.
    return new MailUnavailableError(
      { provider: 'resend' },
      `Resend did not answer: ${error.message}`,
      {
        cause: error,
      },
    )
  }
  return error
}
