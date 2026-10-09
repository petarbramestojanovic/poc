import { z } from 'zod'
import {
  addDays,
  chunkWindow,
  isConsecutive,
  startOfDayIn,
  yesterdayIn,
  type DateWindow,
  type IsoDate,
} from '../../../../core/dates.ts'
import { HttpError } from '../../../../core/http/HttpClient.ts'
import { redact } from '../../../../core/http/redact.ts'
import type {
  CanonicalDailyRow,
  ConnectionCheck,
  ConnectionContext,
  FetchResult,
  LinkEntity,
  RawCapture,
  SourceConnector,
  SyncContext,
} from '../../types.ts'
import { NexdContractError, NexdVerificationError } from './errors.ts'
import { mapNexdRows, performanceDate, type NexdDay } from './mapper.ts'
import {
  nexdLinkConfig,
  nexdResponse,
  type NexdEventItem,
  type NexdLinkConfig,
  type NexdResponse,
  type NexdTotals,
} from './schema.ts'

export { NexdContractError, NexdVerificationError }

// NEXD: one POST per live_id per ≤21-day chunk. Several live_ids belong to one campaign;
// each becomes its own campaign_tag row and campaign totals are computed at read time.

export const NEXD_MAX_WINDOW_DAYS = 21
const DEFAULT_BASE_URL = 'https://api.nexd.com'
/** The connection probe fails fast instead of riding the full retry schedule. */
const PROBE_DEADLINE_MS = 20_000

export interface NexdConnectorOptions {
  baseUrl?: string
  now?: () => Date
}

/** What a request needs: the connection plus, during a run, the capture sink. */
type RequestContext = ConnectionContext & { capture?: (raw: RawCapture) => Promise<void> }

function requestContext(ctx: SyncContext<NexdLinkConfig>): RequestContext {
  return {
    credential: ctx.credential,
    http: ctx.http,
    log: ctx.log,
    dayTimezone: ctx.source.dayTimezone,
    signal: ctx.signal,
    capture: (raw) => ctx.capture(raw),
  }
}

interface ChunkFetch {
  days: NexdDay[]
  totals: NexdTotals
  warnings: string[]
}

export function createNexdConnector(
  options: NexdConnectorOptions = {},
): SourceConnector<NexdLinkConfig> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const now = options.now ?? (() => new Date())

  function analyticsUrl(liveId: string): string {
    return `${baseUrl}/analytics/creatives/${encodeURIComponent(liveId)}`
  }

  function requestBody(window: DateWindow, timeZone: string) {
    // UNIX seconds: from the first second of `from` to the last second of `to`, both in the
    // source's day zone (external.source.day_timezone), never the server's.
    return {
      base: 'impressions',
      startDate: startOfDayIn(window.from, timeZone).getTime() / 1000,
      endDate: startOfDayIn(addDays(window.to, 1), timeZone).getTime() / 1000 - 1,
      traffic: 'all',
      device: 'all',
      incvtr: true,
    }
  }

  async function post(
    ctx: RequestContext,
    liveId: string,
    window: DateWindow,
    extra: { deadlineMs?: number } = {},
  ): Promise<NexdResponse> {
    const url = analyticsUrl(liveId)
    const body = requestBody(window, ctx.dayTimezone)
    const response = await ctx.http.request({
      method: 'POST',
      url,
      body,
      headers: { authorization: `Bearer ${ctx.credential.secret}` },
      credentialKey: ctx.credential.id,
      log: ctx.log,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...extra,
    })
    const parsed = nexdResponse.safeParse(response.json())
    if (!parsed.success) {
      throw new NexdContractError(
        `Unexpected NEXD response shape for ${url}: ${z.prettifyError(parsed.error)}`,
      )
    }
    await ctx.capture?.({
      request: redact({ method: 'POST', url, body }),
      response: parsed.data,
      status: response.status,
      fetchedAt: new Date().toISOString(),
    })
    return parsed.data
  }

  /** Per-day events: `eventsList` when present, otherwise one request per day reading `events[]`. */
  async function eventsPerDay(
    ctx: SyncContext<NexdLinkConfig>,
    liveId: string,
    dates: IsoDate[],
    data: NexdResponse,
  ): Promise<{ events: Map<IsoDate, NexdEventItem[]>; warnings: string[] }> {
    const events = new Map<IsoDate, NexdEventItem[]>()
    const warnings: string[] = []
    const { eventsList } = data.result.analytics

    if (eventsList !== undefined) {
      for (const date of dates) events.set(date, eventsList[date] ?? [])
      return { events, warnings }
    }

    warnings.push(`live_id ${liveId}: eventsList missing, fell back to one request per day`)
    for (const date of dates) {
      ctx.signal.throwIfAborted()
      const dayResponse = await post(requestContext(ctx), liveId, { from: date, to: date })
      const dayEvents = dayResponse.result.analytics.events
      if (dayEvents === undefined) {
        throw new NexdContractError(
          `live_id ${liveId}: neither eventsList nor events[] present for ${date}`,
        )
      }
      events.set(date, dayEvents)
    }
    return { events, warnings }
  }

  async function fetchChunk(
    ctx: SyncContext<NexdLinkConfig>,
    liveId: string,
    window: DateWindow,
  ): Promise<ChunkFetch> {
    const data = await post(requestContext(ctx), liveId, window)
    const analytics = data.result.analytics
    const warnings: string[] = []
    const dayOf = (item: (typeof analytics.performance)[number]) =>
      performanceDate(item, ctx.source.dayTimezone)

    const inWindow = analytics.performance.filter((item) => {
      const date = dayOf(item)
      return date >= window.from && date <= window.to
    })
    if (inWindow.length !== analytics.performance.length) {
      warnings.push(
        `live_id ${liveId}: ignored ${analytics.performance.length - inWindow.length} day(s) outside ${window.from}..${window.to}`,
      )
    }
    const dates = inWindow.map(dayOf)
    if (!isConsecutive(dates)) {
      throw new NexdContractError(
        `live_id ${liveId}: performance days are not consecutive in ${window.from}..${window.to}: ${dates.join(', ')}`,
      )
    }
    if (analytics.summary === undefined) {
      throw new NexdContractError(
        `live_id ${liveId}: summary.totals missing, cannot verify the window`,
      )
    }

    const perDay = await eventsPerDay(ctx, liveId, dates, data)
    const days: NexdDay[] = inWindow.map((performance) => {
      const date = dayOf(performance)
      return { date, performance, events: perDay.events.get(date) ?? [] }
    })
    return { days, totals: analytics.summary.totals, warnings: [...warnings, ...perDay.warnings] }
  }

  /** The written days must add up to what NEXD itself reports for the window. */
  function verify(liveId: string, rows: CanonicalDailyRow[], totals: NexdTotals): void {
    const sum = (id: 'impressions' | 'in_view' | 'game_started') =>
      rows.reduce((acc, row) => acc + (row.metrics[id] ?? 0), 0)
    const checks: [string, number, number][] = [
      ['impressions', sum('impressions'), totals.impressions],
      ['in_view', sum('in_view'), totals.viewable],
      ['game_started', sum('game_started'), totals.engagement.clicks],
    ]
    const mismatches = checks.filter(([, got, want]) => got !== want)
    if (mismatches.length > 0) {
      const detail = mismatches.map(([m, got, want]) => `${m} ${got} ≠ ${want}`).join(', ')
      throw new NexdVerificationError(
        `live_id ${liveId}: written days do not match summary.totals (${detail})`,
      )
    }
  }

  async function fetchEntity(
    ctx: SyncContext<NexdLinkConfig>,
    entity: LinkEntity,
  ): Promise<{ rows: CanonicalDailyRow[]; warnings: string[] }> {
    const maxDays = Math.min(NEXD_MAX_WINDOW_DAYS, ctx.source.maxWindowDays || NEXD_MAX_WINDOW_DAYS)
    const days: NexdDay[] = []
    const warnings: string[] = []
    const totals: NexdTotals = { impressions: 0, viewable: 0, engagement: { clicks: 0 } }

    for (const chunk of chunkWindow(ctx.window, maxDays)) {
      ctx.signal.throwIfAborted()
      const fetched = await fetchChunk(ctx, entity.externalId, chunk)
      days.push(...fetched.days)
      warnings.push(...fetched.warnings)
      totals.impressions += fetched.totals.impressions
      totals.viewable += fetched.totals.viewable
      totals.engagement.clicks += fetched.totals.engagement.clicks
    }

    const rows = mapNexdRows({
      language: ctx.link.language,
      campaignTag: entity.campaignTag,
      eventMap: ctx.eventMap,
      days,
    })
    verify(entity.externalId, rows, totals)
    return { rows, warnings }
  }

  return {
    id: 'nexd',
    capabilities: {
      granularity: 'daily',
      restatementWindowDays: 7,
      maxWindowDays: NEXD_MAX_WINDOW_DAYS,
      verifiesAgainstTotals: true,
    },
    identity: { levels: ['creative'], multiple: true },

    describe: () => ({ configSchema: nexdLinkConfig }),

    // NEXD documents no ping endpoint: probe the analytics endpoint with a placeholder id.
    //   2xx, or a 4xx other than 401/403/429  → the key was accepted (the id simply does not exist)
    //   401 / 403                             → the key was rejected
    //   429 / 5xx                             → NEXD is not answering normally: we cannot tell
    // Confirm the exact statuses in step 14.
    async checkConnection(ctx): Promise<ConnectionCheck> {
      const day = yesterdayIn(ctx.dayTimezone, now())
      try {
        await post(ctx, '0', { from: day, to: day }, { deadlineMs: PROBE_DEADLINE_MS })
        return { ok: true, message: 'NEXD accepted the API key' }
      } catch (error) {
        if (error instanceof HttpError) {
          if (error.status === 401 || error.status === 403) {
            return { ok: false, message: `NEXD rejected the API key (HTTP ${error.status})` }
          }
          if (error.status === 429 || error.status >= 500) {
            return {
              ok: false,
              message: `NEXD is not answering normally (HTTP ${error.status}); the key could not be checked`,
            }
          }
          return {
            ok: true,
            message: `NEXD accepted the API key (HTTP ${error.status} for the placeholder creative)`,
          }
        }
        if (error instanceof NexdContractError) {
          return {
            ok: true,
            message: 'NEXD accepted the API key (unexpected body for the placeholder)',
          }
        }
        throw error
      }
    },

    async fetchWindow(ctx): Promise<FetchResult> {
      const creatives = ctx.entities.filter((e) => e.level === 'creative')
      if (creatives.length === 0) {
        throw new NexdContractError(`link ${ctx.link.id} has no creative (live_id) entity`)
      }
      const result: FetchResult = { rows: [], warnings: [], covered: ctx.window }
      for (const entity of creatives) {
        const fetched = await fetchEntity(ctx, entity)
        result.rows.push(...fetched.rows)
        result.warnings.push(...fetched.warnings)
      }
      return result
    },
  }
}
