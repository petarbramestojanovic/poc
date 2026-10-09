import { readFileSync } from 'node:fs'
import type { DateWindow } from '../../../src/core/dates.ts'
import {
  HttpError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../../../src/core/http/HttpClient.ts'
import { createLogger } from '../../../src/core/log.ts'
import type { ZeusLinkConfig } from '../../../src/modules/sync/connectors/zeus/schema.ts'
import {
  createRunMemo,
  type ConnectionContext,
  type LinkEntity,
  type RawCapture,
  type RunMemo,
  type SyncContext,
} from '../../../src/modules/sync/types.ts'

export const FIXTURE_WINDOW: DateWindow = { from: '2026-09-01', to: '2026-09-03' }
/** A clock for which the fixture window is entirely in the past. */
export const NOW = () => new Date('2026-09-05T10:00:00Z')

type Report = 'campaigns' | 'creatives' | 'devices' | 'tracker'

export function loadFixture(report: Report): {
  from: string
  to: string
  rows: Record<string, unknown>[]
} {
  const url = new URL(
    `../../../src/modules/sync/connectors/zeus/fixtures/${report}.json`,
    import.meta.url,
  )
  return JSON.parse(readFileSync(url, 'utf8')) as {
    from: string
    to: string
    rows: Record<string, unknown>[]
  }
}

export interface Seen {
  report: Report
  window: DateWindow
  filter: Record<string, string>
}

/** Serves a scripted body per report; records what was requested. */
export function fakeHttp(respond: (seen: Seen) => unknown): HttpClient & {
  requests: Seen[]
  authHeaders: (string | undefined)[]
  signals: (AbortSignal | undefined)[]
} {
  const requests: Seen[] = []
  const authHeaders: (string | undefined)[] = []
  const signals: (AbortSignal | undefined)[] = []
  return {
    requests,
    authHeaders,
    signals,
    request: (req: HttpRequest): Promise<HttpResponse> => {
      const url = new URL(req.url)
      const report = url.pathname.split('/').pop() as Report
      const filter: Record<string, string> = {}
      for (const [k, v] of url.searchParams) if (k !== 'from' && k !== 'to') filter[k] = v
      const seen: Seen = {
        report,
        window: { from: url.searchParams.get('from') ?? '', to: url.searchParams.get('to') ?? '' },
        filter,
      }
      requests.push(seen)
      authHeaders.push(req.headers?.authorization)
      signals.push(req.signal)
      const json = respond(seen)
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        text: JSON.stringify(json),
        json: () => json,
      })
    },
  }
}

/** The fixture for a report, answered for exactly the requested window. */
export function fixtureFor(seen: Seen) {
  const fixture = loadFixture(seen.report)
  const rows = fixture.rows.filter((r) => {
    const date = r.date as string
    return date >= seen.window.from && date <= seen.window.to
  })
  return { ...fixture, from: seen.window.from, to: seen.window.to, rows }
}

export const empty = (seen: Seen) => ({ from: seen.window.from, to: seen.window.to, rows: [] })

/** Default script: the fixture for each report, filtered to the requested window. */
export function fixtureHttp(overrides: Partial<Record<Report, (seen: Seen) => unknown>> = {}) {
  return fakeHttp((seen) => {
    const override = overrides[seen.report]
    return override ? override(seen) : fixtureFor(seen)
  })
}

export function httpStatus(status: number): HttpClient {
  return {
    request: () =>
      Promise.reject(new HttpError(status, 'https://zeus.test/api/v1/reports/campaigns', '')),
  }
}

export const ENTITIES = {
  campaign: {
    level: 'campaign',
    externalId: 'camp-ext-1',
    role: null,
    label: 'Tchibo',
    campaignTag: '',
  },
  mpuV1: {
    level: 'creative',
    externalId: '12345',
    role: null,
    label: 'ENG Swipe MPU V1',
    campaignTag: 'mpu_v1',
  },
  mpuV2: {
    level: 'creative',
    externalId: '12346',
    role: null,
    label: 'ENG Swipe MPU V2',
    campaignTag: 'mpu_v2',
  },
  engagement: {
    level: 'pixel',
    externalId: 'dev1eng',
    role: 'engagement',
    label: 'V1 engagement',
    campaignTag: 'mpu_v1',
  },
  finish: {
    level: 'pixel',
    externalId: 'dev1fin',
    role: 'finish',
    label: 'V1 finish',
    campaignTag: 'mpu_v1',
  },
} satisfies Record<string, LinkEntity>

export const ALL_ENTITIES: LinkEntity[] = Object.values(ENTITIES)

export const DEFAULT_CONFIG: ZeusLinkConfig = {
  clickthrough_cta_id: 'clickthrough',
  campaign_id_param: 'external_id',
}

export interface ContextOptions {
  dayTimezone?: string
  signal?: AbortSignal
  memo?: RunMemo
  linkId?: string
}

export type TestContext = SyncContext<ZeusLinkConfig> & { captures: RawCapture[] }

export function context(
  http: HttpClient,
  window: DateWindow = FIXTURE_WINDOW,
  entities: LinkEntity[] = ALL_ENTITIES,
  config: ZeusLinkConfig = DEFAULT_CONFIG,
  options: ContextOptions = {},
): TestContext {
  const captures: RawCapture[] = []
  return {
    source: {
      id: 'zeus',
      displayName: 'ATK (Zeus)',
      dayTimezone: options.dayTimezone ?? 'UTC',
      lookbackDays: 7,
      deepLookbackDays: 35,
      maxWindowDays: 31,
    },
    link: {
      id: options.linkId ?? 'link-2',
      campaignId: 'camp-1',
      sourceId: 'zeus',
      credentialId: 'cred-2',
      language: 'de',
      config,
      enabled: true,
    },
    config,
    entities,
    eventMap: [],
    credential: { id: 'cred-2', name: 'zeus-main', secret: 'zeus-token', accountScope: {} },
    window,
    http,
    log: createLogger('silent'),
    signal: options.signal ?? new AbortController().signal,
    capture: (raw) => {
      captures.push(raw)
      return Promise.resolve()
    },
    memo: options.memo ?? createRunMemo(),
    captures,
  }
}

export function connection(http: HttpClient, dayTimezone = 'UTC'): ConnectionContext {
  return {
    credential: { id: 'cred-2', name: 'zeus-main', secret: 'zeus-token', accountScope: {} },
    http,
    log: createLogger('silent'),
    dayTimezone,
  }
}
