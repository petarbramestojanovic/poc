import { readFileSync } from 'node:fs'
import type { DateWindow } from '../../../src/dates.ts'
import type { HttpClient, HttpRequest, HttpResponse } from '../../../src/http/HttpClient.ts'
import { createLogger } from '../../../src/log.ts'
import type { LinkEntity, SyncContext } from '../../../src/sync/types.ts'

export const FIXTURE_WINDOW: DateWindow = { from: '2026-09-01', to: '2026-09-03' }
/** A clock for which the fixture window is entirely in the past. */
export const NOW = () => new Date('2026-09-05T10:00:00Z')

type Report = 'campaigns' | 'creatives' | 'devices' | 'tracker'

export function loadFixture(report: Report): { rows: Record<string, unknown>[] } {
  const url = new URL(`../../../src/sync/connectors/zeus/fixtures/${report}.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as { rows: Record<string, unknown>[] }
}

export interface Seen {
  report: Report
  window: DateWindow
  filter: Record<string, string>
}

/** Serves a scripted body per report; records what was requested. */
export function fakeHttp(
  respond: (seen: Seen) => unknown,
): HttpClient & { requests: Seen[]; authHeaders: (string | undefined)[] } {
  const requests: Seen[] = []
  const authHeaders: (string | undefined)[] = []
  return {
    requests,
    authHeaders,
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

/** Default script: the fixture for each report, filtered to the requested window. */
export function fixtureHttp(overrides: Partial<Record<Report, (seen: Seen) => unknown>> = {}) {
  return fakeHttp((seen) => {
    const override = overrides[seen.report]
    if (override) return override(seen)
    const fixture = loadFixture(seen.report)
    const rows = fixture.rows.filter((r) => {
      const date = r.date as string
      return date >= seen.window.from && date <= seen.window.to
    })
    return { ...fixture, rows }
  })
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

export function context(
  http: HttpClient,
  window: DateWindow = FIXTURE_WINDOW,
  entities: LinkEntity[] = ALL_ENTITIES,
  config: Record<string, unknown> = { clickthroughCtaId: 'clickthrough' },
): SyncContext {
  return {
    source: {
      id: 'zeus',
      displayName: 'ATK (Zeus)',
      dayTimezone: 'UTC',
      lookbackDays: 7,
      deepLookbackDays: 35,
      maxWindowDays: 31,
    },
    link: {
      id: 'link-2',
      campaignId: 'camp-1',
      sourceId: 'zeus',
      credentialId: 'cred-2',
      language: 'de',
      config,
      enabled: true,
    },
    entities,
    eventMap: [],
    credential: { id: 'cred-2', name: 'zeus-main', secret: 'zeus-token', accountScope: {} },
    window,
    http,
    log: createLogger('silent'),
  }
}
