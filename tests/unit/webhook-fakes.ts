import type { Db, Params, Queryable, Tx } from '../../src/core/db.ts'
import type { HttpClient, HttpRequest, HttpResponse } from '../../src/core/http/HttpClient.ts'
import { createLogger, type Logger } from '../../src/core/log.ts'

// Fakes for the webhook unit tests: a database that answers by statement name and records what it
// was asked, and an HTTP client that answers a scripted response. Neither touches a socket.

export interface RecordedQuery {
  text: string
  params: unknown[]
}

export type Respond = (text: string, params: unknown[]) => unknown[]

export interface FakeDb {
  db: Db
  queries: RecordedQuery[]
  /** Every recorded statement whose text contains `fragment`. */
  matching(fragment: string): RecordedQuery[]
}

export function fakeDb(respond: Respond = () => []): FakeDb {
  const queries: RecordedQuery[] = []

  const query = <T>(text: string, params: Params = []): Promise<T[]> => {
    queries.push({ text, params: [...params] })
    return Promise.resolve(respond(text, [...params]) as T[])
  }

  const queryable: Queryable = { query }
  const tx: Tx = { query, xactLock: () => Promise.resolve() }

  const db: Db = {
    ...queryable,
    withTransaction: (fn) => fn(tx),
    withAdvisoryLock: async (_key, fn) => ({
      acquired: true,
      result: await fn({ assertHeld: () => Promise.resolve() }),
    }),
    stats: () => ({ total: 0, idle: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  }

  return {
    db,
    queries,
    matching: (fragment) => queries.filter((entry) => entry.text.includes(fragment)),
  }
}

export interface FakeHttp {
  http: HttpClient
  requests: HttpRequest[]
}

export type Answer = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>

/** Builds an HttpResponse the way HttpClient does, so callers can read `.text` and `.json()`. */
export function response(
  status: number,
  text = '',
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: new Headers(headers),
    text,
    json: () => JSON.parse(text) as unknown,
  }
}

export function fakeHttp(answer: Answer): FakeHttp {
  const requests: HttpRequest[] = []
  return {
    requests,
    http: {
      request: async (request) => {
        requests.push(request)
        return answer(request)
      },
    },
  }
}

export const silentLogger = (): Logger => createLogger('silent')
