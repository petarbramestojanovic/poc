import { z } from 'zod'
import {
  addDays,
  chunkWindow,
  yesterdayUtc,
  type DateWindow,
  type IsoDate,
} from '../../../dates.ts'
import { HttpError } from '../../../http/HttpClient.ts'
import { redact } from '../../../http/redact.ts'
import type {
  ConnectionCheck,
  ConnectionContext,
  FetchResult,
  LinkEntity,
  RawCapture,
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
  type ZeusCreativesRow,
  type ZeusTrackerRow,
} from './schema.ts'

// Zeus (ATK): three GETs per ≤31-day chunk. `creatives` filtered by the link's campaign id,
// `tracker` fetched unfiltered and matched locally (code → external_id → name, RFC-003 §2.3),
// `campaigns` only when the link has no creative entity.

export const ZEUS_MAX_WINDOW_DAYS = 31
const DEFAULT_BASE_URL = 'https://t.zeus.ad'

export class ZeusContractError extends Error {
  override readonly name = 'ZeusContractError'
}

export interface ZeusConnectorOptions {
  baseUrl?: string
  /** Injectable clock; Zeus serves complete days only, so `to` is clamped to yesterday. */
  now?: () => Date
}

type Report = 'campaigns' | 'creatives' | 'devices' | 'tracker'

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

export function createZeusConnector(options: ZeusConnectorOptions = {}): SourceConnector & {
  listPixels(ctx: ConnectionContext): Promise<PixelSummary[]>
} {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const now = options.now ?? (() => new Date())

  async function get<T extends z.ZodType>(
    ctx: ConnectionContext,
    report: Report,
    window: DateWindow,
    rowSchema: T,
    filter: Record<string, string> = {},
  ): Promise<{ rows: z.infer<T>[]; raw: RawCapture }> {
    const url = new URL(`${baseUrl}/api/v1/reports/${report}`)
    url.searchParams.set('from', window.from)
    url.searchParams.set('to', window.to)
    for (const [key, value] of Object.entries(filter)) url.searchParams.set(key, value)

    const response = await ctx.http.request({
      method: 'GET',
      url: url.toString(),
      headers: { authorization: `Bearer ${ctx.credential.secret}` },
      credentialKey: ctx.credential.id,
    })
    const parsed = zeusReport(rowSchema).safeParse(response.json())
    if (!parsed.success) {
      throw new ZeusContractError(
        `Unexpected Zeus ${report} response: ${z.prettifyError(parsed.error)}`,
      )
    }
    const raw: RawCapture = {
      request: redact({ method: 'GET', url: url.toString() }),
      response: parsed.data,
      status: response.status,
      fetchedAt: new Date().toISOString(),
    }
    return { rows: parsed.data.rows, raw }
  }

  /** Filtered by the configured id param; if that yields nothing, retried with the other one. */
  async function getFiltered<T extends z.ZodType>(
    ctx: SyncContext,
    report: Report,
    window: DateWindow,
    rowSchema: T,
    param: 'external_id' | 'internal_id',
    id: string,
    warnings: string[],
  ) {
    const first = await get(ctx, report, window, rowSchema, { [param]: id })
    if (first.rows.length > 0) return { rows: first.rows, raw: [first.raw] }
    const other = param === 'external_id' ? 'internal_id' : 'external_id'
    const second = await get(ctx, report, window, rowSchema, { [other]: id })
    if (second.rows.length > 0) {
      warnings.push(`${report}: no rows for ${param}=${id}, matched with ${other} instead`)
    }
    return { rows: second.rows, raw: [first.raw, second.raw] }
  }

  async function fetchChunk(
    ctx: SyncContext,
    window: DateWindow,
    result: FetchResult,
    input: ZeusMapperInput,
  ) {
    const config = zeusLinkConfig.parse(ctx.link.config)
    const campaign = ctx.entities.find((e) => e.level === 'campaign')
    const creatives = ctx.entities.filter((e) => e.level === 'creative')
    const pixels = ctx.entities.filter((e) => e.level === 'pixel')

    if (creatives.length > 0) {
      const byId = new Map(creatives.map((e) => [e.externalId, e]))
      const fetched = campaign
        ? await getFiltered(
            ctx,
            'creatives',
            window,
            zeusCreativesRow,
            config.campaignIdParam,
            campaign.externalId,
            result.warnings,
          )
        : await getPerCreative(ctx, window, creatives, config.campaignIdParam, result.warnings)
      result.raw.push(...fetched.raw)
      for (const row of fetched.rows) {
        const entity =
          byId.get(row.creative_id) ?? (row.external_id ? byId.get(row.external_id) : undefined)
        if (!entity) {
          result.warnings.push(
            `creatives: row for unknown creative ${row.creative_id} on ${row.date} ignored`,
          )
          continue
        }
        input.creatives.push({ entity, row })
      }
    } else if (campaign) {
      const fetched = await getFiltered(
        ctx,
        'campaigns',
        window,
        zeusCampaignsRow,
        config.campaignIdParam,
        campaign.externalId,
        result.warnings,
      )
      result.raw.push(...fetched.raw)
      for (const row of fetched.rows) input.campaigns.push({ entity: campaign, row })
    } else {
      throw new ZeusContractError(
        `link ${ctx.link.id} has neither a campaign nor a creative entity`,
      )
    }

    if (pixels.length > 0) {
      const tracker = await get(ctx, 'tracker', window, zeusTrackerRow)
      result.raw.push(tracker.raw)
      for (const row of tracker.rows) {
        const entity = matchPixel(row, pixels)
        if (entity) input.tracker.push({ entity, row })
        else
          input.unmatchedPixels.push({ label: pixelLabel(row), date: row.date, fires: row.fires })
      }
    }
  }

  async function getPerCreative(
    ctx: SyncContext,
    window: DateWindow,
    creatives: LinkEntity[],
    param: 'external_id' | 'internal_id',
    warnings: string[],
  ): Promise<{ rows: ZeusCreativesRow[]; raw: RawCapture[] }> {
    const rows: ZeusCreativesRow[] = []
    const raw: RawCapture[] = []
    for (const creative of creatives) {
      const fetched = await getFiltered(
        ctx,
        'creatives',
        window,
        zeusCreativesRow,
        param,
        creative.externalId,
        warnings,
      )
      rows.push(...fetched.rows)
      raw.push(...fetched.raw)
    }
    return { rows, raw }
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
      const day = yesterdayUtc(now())
      try {
        await get(ctx, 'campaigns', { from: day, to: day }, zeusCampaignsRow)
        return { ok: true, message: 'Zeus accepted the token' }
      } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          return { ok: false, message: `Zeus rejected the token (HTTP ${error.status})` }
        }
        throw error
      }
    },

    async fetchWindow(ctx): Promise<FetchResult> {
      const config = zeusLinkConfig.parse(ctx.link.config)
      const result: FetchResult = { rows: [], raw: [], warnings: [] }
      const input: ZeusMapperInput = {
        language: ctx.link.language,
        clickthroughCtaId: config.clickthroughCtaId,
        creatives: [],
        campaigns: [],
        tracker: [],
        unmatchedPixels: [],
      }

      const yesterday = yesterdayUtc(now())
      let window = ctx.window
      if (window.to > yesterday) {
        result.warnings.push(
          `Zeus serves complete days only: window end ${window.to} clamped to ${yesterday}`,
        )
        window = { from: window.from, to: yesterday }
        if (window.from > window.to) return result
      }

      const maxDays = Math.min(
        ZEUS_MAX_WINDOW_DAYS,
        ctx.source.maxWindowDays || ZEUS_MAX_WINDOW_DAYS,
      )
      for (const chunk of chunkWindow(window, maxDays)) await fetchChunk(ctx, chunk, result, input)

      checkZeusInvariants(input.creatives)
      result.rows = mapZeusRows(input)
      return result
    },

    /** Discovery for onboarding: every pixel the token can see, with fires over the last 7 days. */
    async listPixels(ctx): Promise<PixelSummary[]> {
      const to = yesterdayUtc(now())
      const { rows } = await get(ctx, 'tracker', { from: addDays(to, -6), to }, zeusTrackerRow)
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
