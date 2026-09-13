import { z } from 'zod'
import { addDays, chunkWindow, yesterdayIn, type DateWindow, type IsoDate } from '../../../dates.ts'
import { HttpError } from '../../../http/HttpClient.ts'
import { redact } from '../../../http/redact.ts'
import { ConnectorContractError } from '../../errors.ts'
import type {
  ConnectionCheck,
  ConnectionContext,
  FetchResult,
  LinkEntity,
  RawCapture,
  RunMemo,
  SourceConnector,
  SyncContext,
} from '../../types.ts'
import { checkZeusInvariants, mapZeusRows, type ZeusMapperInput } from './mapper.ts'
import {
  zeusCampaignsRow,
  zeusCreativesRow,
  zeusLinkConfig,
  zeusReport,
  zeusTrackerRow,
  type ZeusLinkConfig,
  type ZeusTrackerRow,
} from './schema.ts'

// Zeus (ATK): three GETs per ≤31-day chunk. `creatives` filtered by the link's campaign id,
// `tracker` fetched unfiltered and matched locally (code → external_id → name, RFC-003 §2.3),
// `campaigns` only when the link has no creative entity.

export const ZEUS_MAX_WINDOW_DAYS = 31
const DEFAULT_BASE_URL = 'https://t.zeus.ad'
const PROBE_DEADLINE_MS = 20_000

export class ZeusContractError extends ConnectorContractError {
  override readonly name = 'ZeusContractError'
}

export interface ZeusConnectorOptions {
  baseUrl?: string
  /** Injectable clock; Zeus serves complete days only, so `to` is clamped to yesterday. */
  now?: () => Date
}

type Report = 'campaigns' | 'creatives' | 'devices' | 'tracker'
type RequestContext = ConnectionContext & { capture?: (raw: RawCapture) => Promise<void> }

/** Resolves which tracker field carries our ATK identity without guessing: code, external_id, name. */
export function matchPixel(row: ZeusTrackerRow, pixels: LinkEntity[]): LinkEntity | undefined {
  for (const field of ['code', 'external_id', 'name'] as const) {
    const value = row[field]
    if (value === null || value === undefined || value === '') continue
    const hit = pixels.find((p) => p.externalId === value)
    if (hit) return hit
  }
  return undefined
}

export function pixelLabel(row: ZeusTrackerRow): string {
  return `pixel ${row.pixel_id} "${row.name ?? row.code ?? row.external_id ?? ''}"`
}

export interface PixelSummary {
  pixel_id: string
  external_id: string | null
  code: string | null
  name: string | null
  fires_last_7_days: number
}

export type ZeusConnector = SourceConnector<ZeusLinkConfig> & {
  listPixels(ctx: ConnectionContext): Promise<PixelSummary[]>
}

/** Mutable per-fetch state: deduplicated warnings and the newest day Zeus actually served. */
interface FetchState {
  warnings: Set<string>
  /** Set when Zeus answered with a `to` earlier than requested (its own clamp). */
  servedTo: IsoDate | undefined
}

export function createZeusConnector(options: ZeusConnectorOptions = {}): ZeusConnector {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const now = options.now ?? (() => new Date())

  function requestContext(ctx: SyncContext<ZeusLinkConfig>): RequestContext {
    return {
      credential: ctx.credential,
      http: ctx.http,
      log: ctx.log,
      dayTimezone: ctx.source.dayTimezone,
      signal: ctx.signal,
      capture: (raw) => ctx.capture(raw),
    }
  }

  async function get<T extends z.ZodType>(
    ctx: RequestContext,
    report: Report,
    window: DateWindow,
    rowSchema: T,
    filter: Record<string, string> = {},
    state?: FetchState,
    extra: { deadlineMs?: number } = {},
  ): Promise<z.infer<T>[]> {
    const url = new URL(`${baseUrl}/api/v1/reports/${report}`)
    url.searchParams.set('from', window.from)
    url.searchParams.set('to', window.to)
    for (const [key, value] of Object.entries(filter)) url.searchParams.set(key, value)

    const response = await ctx.http.request({
      method: 'GET',
      url: url.toString(),
      headers: { authorization: `Bearer ${ctx.credential.secret}` },
      credentialKey: ctx.credential.id,
      log: ctx.log,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...extra,
    })
    const parsed = zeusReport(rowSchema).safeParse(response.json())
    if (!parsed.success) {
      throw new ZeusContractError(
        `Unexpected Zeus ${report} response: ${z.prettifyError(parsed.error)}`,
      )
    }
    const data = parsed.data
    if (data.from !== window.from || data.to > window.to) {
      throw new ZeusContractError(
        `Zeus ${report} answered for ${data.from}..${data.to}, requested ${window.from}..${window.to}`,
      )
    }
    if (
      state &&
      data.to < window.to &&
      (state.servedTo === undefined || data.to < state.servedTo)
    ) {
      state.servedTo = data.to
    }
    await ctx.capture?.({
      request: redact({ method: 'GET', url: url.toString() }),
      response: data,
      status: response.status,
      fetchedAt: new Date().toISOString(),
    })
    return data.rows
  }

  /**
   * Filtered by the configured id param; if that yields nothing, retried with the other one.
   * Every returned row must belong to the requested entity: a value that happens to collide
   * with ANOTHER campaign's id in the other parameter would otherwise be written under ours.
   */
  async function getFiltered<T extends z.ZodType>(
    ctx: SyncContext<ZeusLinkConfig>,
    report: Report,
    window: DateWindow,
    rowSchema: T,
    param: 'external_id' | 'internal_id',
    id: string,
    belongs: (row: z.infer<T>) => boolean,
    describeRow: (row: z.infer<T>) => string,
    state: FetchState,
  ): Promise<z.infer<T>[]> {
    const other = param === 'external_id' ? 'internal_id' : 'external_id'
    for (const used of [param, other] as const) {
      const rows = await get(requestContext(ctx), report, window, rowSchema, { [used]: id }, state)
      if (rows.length === 0) continue
      const stranger = rows.find((row) => !belongs(row))
      if (stranger !== undefined) {
        const count = rows.filter((row) => !belongs(row)).length
        throw new ZeusContractError(
          `${report}: ${count} row(s) returned for ${used}=${id} belong elsewhere (e.g. ${describeRow(stranger)}); refusing to attribute them`,
        )
      }
      // Recorded on every run until step 14 confirms which parameter Zeus actually honours.
      state.warnings.add(
        used === param
          ? `${report}: rows matched with ${used}=${id}`
          : `${report}: no rows for ${param}=${id}, matched with ${other} instead`,
      )
      return rows
    }
    return []
  }

  const campaignOf =
    (id: string) => (row: { campaign_id: string; external_id?: string | null | undefined }) =>
      row.campaign_id === id || row.external_id === id

  async function fetchChunk(
    ctx: SyncContext<ZeusLinkConfig>,
    window: DateWindow,
    input: ZeusMapperInput,
    state: FetchState,
    memo: RunMemo,
  ): Promise<void> {
    const config = ctx.config
    const campaign = ctx.entities.find((e) => e.level === 'campaign')
    const creatives = ctx.entities.filter((e) => e.level === 'creative')
    const pixels = ctx.entities.filter((e) => e.level === 'pixel')

    if (creatives.length > 0) {
      const byId = new Map(creatives.map((e) => [e.externalId, e]))
      const rows = campaign
        ? await getFiltered(
            ctx,
            'creatives',
            window,
            zeusCreativesRow,
            config.campaign_id_param,
            campaign.externalId,
            campaignOf(campaign.externalId),
            (row) => `campaign_id ${row.campaign_id}`,
            state,
          )
        : (
            await Promise.all(
              creatives.map((creative) =>
                getFiltered(
                  ctx,
                  'creatives',
                  window,
                  zeusCreativesRow,
                  config.campaign_id_param,
                  creative.externalId,
                  (row) => row.creative_id === creative.externalId,
                  (row) => `creative_id ${row.creative_id}`,
                  state,
                ),
              ),
            )
          ).flat()
      for (const row of rows) {
        const entity = byId.get(row.creative_id)
        if (!entity) {
          state.warnings.add(`creatives: rows for unlinked creative ${row.creative_id} ignored`)
          continue
        }
        input.creatives.push({ entity, row })
      }
    } else if (campaign) {
      const rows = await getFiltered(
        ctx,
        'campaigns',
        window,
        zeusCampaignsRow,
        config.campaign_id_param,
        campaign.externalId,
        campaignOf(campaign.externalId),
        (row) => `campaign_id ${row.campaign_id}`,
        state,
      )
      for (const row of rows) input.campaigns.push({ entity: campaign, row })
    } else {
      throw new ZeusContractError(
        `link ${ctx.link.id} has neither a campaign nor a creative entity`,
      )
    }

    if (pixels.length > 0) {
      // The unfiltered tracker report is identical for every link on this credential: one
      // download serves every link in the same run memo (a scheduler pass shares one).
      const tracker = await memo.getOrLoad(
        `zeus:tracker:${ctx.credential.id}:${window.from}:${window.to}`,
        () => get(requestContext(ctx), 'tracker', window, zeusTrackerRow, {}, state),
      )
      for (const row of tracker) {
        const entity = matchPixel(row, pixels)
        if (entity) input.tracker.push({ entity, row })
        else
          input.unmatchedPixels.push({ label: pixelLabel(row), date: row.date, fires: row.fires })
      }
    }
  }

  return {
    id: 'zeus',
    capabilities: {
      granularity: 'daily',
      restatementWindowDays: 7,
      maxWindowDays: ZEUS_MAX_WINDOW_DAYS,
      verifiesAgainstTotals: false,
    },
    identity: {
      levels: ['campaign', 'creative', 'pixel'],
      multiple: true,
      roles: { pixel: ['engagement', 'finish'] },
    },

    describe: () => ({ configSchema: zeusLinkConfig }),

    async checkConnection(ctx): Promise<ConnectionCheck> {
      const day = yesterdayIn(ctx.dayTimezone, now())
      try {
        await get(ctx, 'campaigns', { from: day, to: day }, zeusCampaignsRow, {}, undefined, {
          deadlineMs: PROBE_DEADLINE_MS,
        })
        return { ok: true, message: 'Zeus accepted the token' }
      } catch (error) {
        if (error instanceof HttpError) {
          if (error.status === 401 || error.status === 403) {
            return { ok: false, message: `Zeus rejected the token (HTTP ${error.status})` }
          }
          return {
            ok: false,
            message: `Zeus is not answering normally (HTTP ${error.status}); the token could not be checked`,
          }
        }
        throw error
      }
    },

    async fetchWindow(ctx): Promise<FetchResult> {
      const state: FetchState = { warnings: new Set(), servedTo: undefined }
      const input: ZeusMapperInput = {
        language: ctx.link.language,
        clickthroughCtaId: ctx.config.clickthrough_cta_id,
        creatives: [],
        campaigns: [],
        tracker: [],
        unmatchedPixels: [],
      }

      const yesterday = yesterdayIn(ctx.source.dayTimezone, now())
      let window = ctx.window
      if (window.to > yesterday) {
        state.warnings.add(
          `Zeus serves complete days only: window end ${window.to} clamped to ${yesterday} (${ctx.source.dayTimezone})`,
        )
        if (window.from > yesterday)
          return { rows: [], warnings: [...state.warnings], covered: null }
        window = { from: window.from, to: yesterday }
      }

      const maxDays = Math.min(
        ZEUS_MAX_WINDOW_DAYS,
        ctx.source.maxWindowDays || ZEUS_MAX_WINDOW_DAYS,
      )
      for (const chunk of chunkWindow(window, maxDays)) {
        ctx.signal.throwIfAborted()
        await fetchChunk(ctx, chunk, input, state, ctx.memo)
      }

      checkZeusInvariants(input, (warning) => state.warnings.add(warning))
      const warnings = [...state.warnings]
      const rows = mapZeusRows(input, (w) => warnings.push(w))
      const coveredTo = state.servedTo ?? window.to
      return { rows, warnings, covered: { from: window.from, to: coveredTo } }
    },

    /** Discovery for onboarding: every pixel the token can see, with fires over the last 7 days. */
    async listPixels(ctx): Promise<PixelSummary[]> {
      const to = yesterdayIn(ctx.dayTimezone, now())
      const rows = await get(ctx, 'tracker', { from: addDays(to, -6), to }, zeusTrackerRow)
      const byPixel = new Map<string, PixelSummary>()
      for (const row of rows) {
        const entry = byPixel.get(row.pixel_id) ?? {
          pixel_id: row.pixel_id,
          external_id: row.external_id ?? null,
          code: row.code ?? null,
          name: row.name ?? null,
          fires_last_7_days: 0,
        }
        entry.fires_last_7_days += row.fires
        byPixel.set(row.pixel_id, entry)
      }
      return [...byPixel.values()].sort((a, b) => b.fires_last_7_days - a.fires_last_7_days)
    },
  }
}

export type { IsoDate }
