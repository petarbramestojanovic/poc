import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { addDays, eachDay, type DateWindow } from '../../../src/dates.ts'
import {
  HttpError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../../../src/http/HttpClient.ts'
import { createLogger } from '../../../src/log.ts'
import type { NexdLinkConfig } from '../../../src/sync/connectors/nexd/schema.ts'
import {
  createRunMemo,
  type ConnectionContext,
  type EventMapEntry,
  type LinkEntity,
  type RawCapture,
  type SyncContext,
} from '../../../src/sync/types.ts'

export const FIXTURE_WINDOW: DateWindow = { from: '2026-08-31', to: '2026-09-06' }

export const KNOWN_TOTALS = {
  impressions: 76_200,
  in_view: 64_847,
  game_started: 5_055,
  interactions: 4_620,
  hovered: 1_893,
} as const

export function loadFixture(): Record<string, unknown> {
  const url = new URL(
    '../../../src/sync/connectors/nexd/fixtures/creative-analytics.json',
    import.meta.url,
  )
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>
}

export const EVENT_MAP: EventMapEntry[] = [
  { eventName: 'Page seen [Main]', targetKind: 'page_view', targetId: 'main' },
  { eventName: 'Page seen [Result]', targetKind: 'page_view', targetId: 'result' },
  { eventName: 'CTR [global]', targetKind: 'cta_click', targetId: 'clickthrough' },
]

export const entity = (liveId: string, tag = liveId): LinkEntity => ({
  level: 'creative',
  externalId: liveId,
  role: null,
  label: `Creative ${liveId}`,
  campaignTag: tag,
})

const requestBody = z.object({ startDate: z.number(), endDate: z.number() })

export interface RequestMeta {
  signal: AbortSignal | undefined
  log: unknown
  deadlineMs: number | undefined
}

/** Serves a scripted response per request; the script sees the requested window (UTC days). */
export function fakeHttp(
  respond: (req: HttpRequest, window: DateWindow) => unknown,
): HttpClient & { requests: { url: string; window: DateWindow }[]; meta: RequestMeta[] } {
  const requests: { url: string; window: DateWindow }[] = []
  const meta: RequestMeta[] = []
  return {
    requests,
    meta,
    request: (req: HttpRequest): Promise<HttpResponse> => {
      const body = requestBody.parse(req.body)
      const window = {
        from: new Date(body.startDate * 1000).toISOString().slice(0, 10),
        to: new Date(body.endDate * 1000).toISOString().slice(0, 10),
      }
      requests.push({ url: req.url, window })
      meta.push({ signal: req.signal, log: req.log, deadlineMs: req.deadlineMs })
      const json = respond(req, window)
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        text: JSON.stringify(json),
        json: () => json,
      })
    },
  }
}

/** Every request fails with the given error. */
export function failingHttp(error: Error): HttpClient & { meta: RequestMeta[] } {
  const meta: RequestMeta[] = []
  return {
    meta,
    request: (req) => {
      meta.push({ signal: req.signal, log: req.log, deadlineMs: req.deadlineMs })
      return Promise.reject(error)
    },
  }
}

export const httpStatus = (status: number) =>
  failingHttp(new HttpError(status, 'https://nexd.test/analytics/creatives/0', ''))

/** A synthetic response with 1 impression per day, so chunk tests can check coverage. */
export function syntheticResponse(window: DateWindow, withEventsList = true) {
  const days = eachDay(window.from, window.to)
  const perf = days.map((date) => ({
    date,
    impressions: 100,
    viewable: { value: 80 },
    engagement: { value: 10 },
    dwell: 20_000,
  }))
  const item = (name: string, count: number) => ({ action: { original: name }, count })
  const analytics: Record<string, unknown> = {
    performance: perf,
    events: [item('Unique [Touch]', 5 * days.length)],
    summary: {
      totals: {
        impressions: 100 * days.length,
        viewable: 80 * days.length,
        engagement: { clicks: 10 * days.length },
      },
    },
  }
  if (withEventsList) {
    analytics.eventsList = Object.fromEntries(days.map((d) => [d, [item('Unique [Touch]', 5)]]))
  }
  return { result: { analytics } }
}

export interface ContextOptions {
  dayTimezone?: string
  signal?: AbortSignal
}

export type TestContext = SyncContext<NexdLinkConfig> & { captures: RawCapture[] }

export function context(
  http: HttpClient,
  window: DateWindow,
  entities: LinkEntity[] = [entity('nx_1')],
  options: ContextOptions = {},
): TestContext {
  const captures: RawCapture[] = []
  return {
    source: {
      id: 'nexd',
      displayName: 'NEXD',
      dayTimezone: options.dayTimezone ?? 'UTC',
      lookbackDays: 7,
      deepLookbackDays: 35,
      maxWindowDays: 21,
    },
    link: {
      id: 'link-1',
      campaignId: 'camp-1',
      sourceId: 'nexd',
      credentialId: 'cred-1',
      language: 'de',
      config: {},
      enabled: true,
    },
    config: {},
    entities,
    eventMap: EVENT_MAP,
    credential: { id: 'cred-1', name: 'nexd-main', secret: 'test-key', accountScope: {} },
    window,
    http,
    log: createLogger('silent'),
    signal: options.signal ?? new AbortController().signal,
    capture: (raw) => {
      captures.push(raw)
      return Promise.resolve()
    },
    memo: createRunMemo(),
    captures,
  }
}

export function connection(http: HttpClient, dayTimezone = 'UTC'): ConnectionContext {
  return {
    credential: { id: 'cred-1', name: 'nexd-main', secret: 'test-key', accountScope: {} },
    http,
    log: createLogger('silent'),
    dayTimezone,
  }
}

export { addDays }
