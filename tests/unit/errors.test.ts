import { describe, expect, it } from 'vitest'
import {
  DeadlineExceededError,
  HttpError,
  NetworkError,
  ResponseBodyError,
  ResponseTooLargeError,
  RetryBudgetExhaustedError,
} from '../../src/http/HttpClient.ts'
import { NexdContractError } from '../../src/sync/connectors/nexd/connector.ts'
import { ZeusInvariantError } from '../../src/sync/connectors/zeus/mapper.ts'
import {
  classifySyncError,
  CredentialUnavailableError,
  InvalidLinkConfigError,
  LinkDisabledError,
  LinkNotFoundError,
  RunInProgressError,
  SyncAbortedError,
  TooSoonError,
  UnknownSourceError,
} from '../../src/sync/errors.ts'

describe('classifySyncError', () => {
  it.each([
    [
      'link not found',
      new LinkNotFoundError('x'),
      { code: 'link_not_found', retryable: false, status: 404 },
    ],
    [
      'link disabled',
      new LinkDisabledError('x'),
      { code: 'link_disabled', retryable: false, status: 409 },
    ],
    ['cooldown', new TooSoonError('x', 5), { code: 'too_soon', retryable: true, status: 429 }],
    [
      'run in progress',
      new RunInProgressError('x'),
      { code: 'run_in_progress', retryable: true, status: 409 },
    ],
    [
      'bad config',
      new InvalidLinkConfigError('x', []),
      { code: 'invalid_link_config', retryable: false, status: 422 },
    ],
    [
      'unknown source',
      new UnknownSourceError('x', []),
      { code: 'unknown_source', retryable: false, status: 500 },
    ],
    [
      'credential',
      new CredentialUnavailableError('x'),
      { code: 'credential_unavailable', retryable: false, status: 500 },
    ],
    ['aborted', new SyncAbortedError('x'), { code: 'aborted', retryable: true, status: 503 }],
    [
      'NEXD contract',
      new NexdContractError('x'),
      { code: 'contract_violation', retryable: false, status: 502 },
    ],
    [
      'Zeus invariant',
      new ZeusInvariantError('x'),
      { code: 'verification_failed', retryable: false, status: 502 },
    ],
    [
      'upstream 503',
      new HttpError(503, 'https://x', ''),
      { code: 'upstream_http', retryable: true, status: 502 },
    ],
    [
      'upstream 404',
      new HttpError(404, 'https://x', ''),
      { code: 'upstream_http', retryable: false, status: 502 },
    ],
    [
      'network reset',
      new NetworkError('https://x', 0, 'ECONNRESET', true, null),
      { code: 'upstream_network', retryable: true, status: 502 },
    ],
    [
      'retry budget',
      new RetryBudgetExhaustedError('c', { maxRetries: 1, windowMs: 1 }),
      { code: 'upstream_retry_budget', retryable: true, status: 503 },
    ],
    [
      'deadline',
      new DeadlineExceededError('https://x', 10),
      { code: 'upstream_retry_budget', retryable: true, status: 503 },
    ],
    [
      'too large',
      new ResponseTooLargeError('https://x', 1),
      { code: 'upstream_too_large', retryable: false, status: 502 },
    ],
    [
      'non-JSON body',
      new ResponseBodyError(200, 'https://x', 'text/html', '<html>', null),
      { code: 'upstream_bad_body', retryable: false, status: 502 },
    ],
    ['anything else', new Error('bug'), { code: 'internal', retryable: false, status: 500 }],
  ])('%s', (_name, error, expected) => {
    expect(classifySyncError(error)).toEqual(expected)
  })
})
