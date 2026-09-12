import { z } from 'zod'
import {
  chunkWindow,
  isConsecutive,
  toDate,
  type DateWindow,
  type IsoDate,
} from '../../../dates.ts'
import { HttpError } from '../../../http/HttpClient.ts'
import { redact } from '../../../http/redact.ts'
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
import { mapNexdRows, performanceDate, type NexdDay } from './mapper.ts'
import {
  nexdLinkConfig,
  nexdResponse,
  type NexdEventItem,
  type NexdResponse,
  type NexdTotals,
} from './schema.ts'

// NEXD: one POST per live_id per ≤21-day chunk. Several live_ids belong to one campaign;
// each becomes its own campaign_tag row and campaign totals are computed at read time.

export const NEXD_MAX_WINDOW_DAYS = 21
const DEFAULT_BASE_URL = 'https://api.nexd.com'

export class NexdContractError extends Error {
  override readonly name = 'NexdContractError'
}

export class NexdVerificationError extends Error {
  override readonly name = 'NexdVerificationError'
}

export interface NexdConnectorOptions {
  baseUrl?: string
}

interface ChunkFetch {
  days: NexdDay[]
  totals: NexdTotals
  raw: RawCapture[]
  warnings: string[]
}

export function createNexdConnector(options: NexdConnectorOptions = {}): SourceConnector {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')

  function analyticsUrl(liveId: string): string {
    return `${baseUrl}/analytics/creatives/${encodeURIComponent(liveId)}`
  }

  function requestBody(window: DateWindow) {
    // Dates are UNIX seconds; endDate is the last second of the `to` day (UTC).
    return {
      base: 'impressions',
      startDate: toDate(window.from).getTime() / 1000,
      endDate: toDate(window.to).getTime() / 1000 + 86_399,
      traffic: 'all',
      device: 'all',
      incvtr: true,
    }
  }

  async function post(ctx: ConnectionContext, liveId: string, window: DateWindow) {
    const url = analyticsUrl(liveId)
    const body = requestBody(window)
    const response = await ctx.http.request({
      method: 'POST',
      url,
      body,
      headers: { authorization: `Bearer ${ctx.credential.secret}` },
      credentialKey: ctx.credential.id,
    })
    const parsed = nexdResponse.safeParse(response.json())
    if (!parsed.success) {
      throw new NexdContractError(
        `Unexpected NEXD response shape for ${url}: ${z.prettifyError(parsed.error)}`,
      )
    }
    const raw: RawCapture = {
      request: redact({ method: 'POST', url, body }),
      response: parsed.data,
      status: response.status,
      fetchedAt: new Date().toISOString(),
    }
    return { data: parsed.data, raw }
  }

  /** Per-day events: `eventsList` when present, otherwise one request per day reading `events[]`. */
  async function eventsPerDay(
    ctx: SyncContext,
    liveId: string,
    dates: IsoDate[],
    data: NexdResponse,
  ): Promise<{ events: Map<IsoDate, NexdEventItem[]>; raw: RawCapture[]; warnings: string[] }> {
    const events = new Map<IsoDate, NexdEventItem[]>()
    const raw: RawCapture[] = []
    const warnings: string[] = []
    const { eventsList } = data.result.analytics

    if (eventsList !== undefined) {
      for (const date of dates) events.set(date, eventsList[date] ?? [])
      return { events, raw, warnings }
    }

    warnings.push(`live_id ${liveId}: eventsList missing, fell back to one request per day`)
    for (const date of dates) {
      const dayResponse = await post(ctx, liveId, { from: date, to: date })
      raw.push(dayResponse.raw)
      const dayEvents = dayResponse.data.result.analytics.events
      if (dayEvents === undefined) {
        throw new NexdContractError(
          `live_id ${liveId}: neither eventsList nor events[] present for ${date}`,
        )
      }
      events.set(date, dayEvents)
    }
    return { events, raw, warnings }
  }

  async function fetchChunk(
    ctx: SyncContext,
    liveId: string,
    window: DateWindow,
  ): Promise<ChunkFetch> {
    const { data, raw } = await post(ctx, liveId, window)
    const analytics = data.result.analytics
    const warnings: string[] = []

    const inWindow = analytics.performance.filter((item) => {
      const date = performanceDate(item)
      return date >= window.from && date <= window.to
    })
    if (inWindow.length !== analytics.performance.length) {
      warnings.push(
        `live_id ${liveId}: ignored ${analytics.performance.length - inWindow.length} day(s) outside ${window.from}..${window.to}`,
      )
    }
    const dates = inWindow.map(performanceDate)
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
      const date = performanceDate(performance)
      return { date, performance, events: perDay.events.get(date) ?? [] }
    })
    return {
      days,
      totals: analytics.summary.totals,
      raw: [raw, ...perDay.raw],
      warnings: [...warnings, ...perDay.warnings],
    }
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

  async function fetchEntity(ctx: SyncContext, entity: LinkEntity): Promise<FetchResult> {
    const maxDays = Math.min(NEXD_MAX_WINDOW_DAYS, ctx.source.maxWindowDays || NEXD_MAX_WINDOW_DAYS)
    const days: NexdDay[] = []
    const raw: RawCapture[] = []
    const warnings: string[] = []
    const totals: NexdTotals = { impressions: 0, viewable: 0, engagement: { clicks: 0 } }

    for (const chunk of chunkWindow(ctx.window, maxDays)) {
      const fetched = await fetchChunk(ctx, entity.externalId, chunk)
      days.push(...fetched.days)
      raw.push(...fetched.raw)
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
    return { rows, raw, warnings }
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
    // A 401/403 means the key is rejected; anything else means it was accepted. Confirm in step 14.
    async checkConnection(ctx): Promise<ConnectionCheck> {
      try {
        await post(ctx, '0', { from: '2026-01-01', to: '2026-01-01' })
        return { ok: true, message: 'NEXD accepted the API key' }
      } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          return { ok: false, message: `NEXD rejected the API key (HTTP ${error.status})` }
        }
        if (error instanceof HttpError || error instanceof NexdContractError) {
          return { ok: true, message: `NEXD accepted the API key (${error.name})` }
        }
        throw error
      }
    },

    async fetchWindow(ctx): Promise<FetchResult> {
      const creatives = ctx.entities.filter((e) => e.level === 'creative')
      if (creatives.length === 0) {
        throw new NexdContractError(`link ${ctx.link.id} has no creative (live_id) entity`)
      }
      const result: FetchResult = { rows: [], raw: [], warnings: [] }
      for (const entity of creatives) {
        const fetched = await fetchEntity(ctx, entity)
        result.rows.push(...fetched.rows)
        result.raw.push(...fetched.raw)
        result.warnings.push(...fetched.warnings)
      }
      return result
    },
  }
}
