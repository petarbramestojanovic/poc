import type { ZodType } from 'zod'
import type { DateWindow, IsoDate } from '../dates.ts'
import type { HttpClient } from '../http/HttpClient.ts'
import type { Logger } from '../log.ts'

// The whole platform-specific surface is one interface (SourceConnector) and one pure
// function (Mapper). Everything downstream speaks CanonicalDailyRow only (RFC-003 Â§3).

/**
 * analytics.metric ids that are columns of analytics.advanced_analytics, in the column order of
 * src/sync/sql/insert_advanced.sql. An integration test pins both this order and the
 * aggregation map below against the database, so neither can drift.
 */
export const METRIC_IDS = [
  'impressions',
  'in_view',
  'game_started',
  'game_finished',
  'interactions',
  'hovered',
  'in_view_time',
  'dwell_time',
  'interaction_time',
  'dwell_avg_ms',
  'unique_impressions_reported',
  'unique_clicks_reported',
] as const
export type MetricId = (typeof METRIC_IDS)[number]

export type Aggregation = 'sum' | 'weighted_avg' | 'none'

/** Mirrors analytics.metric.aggregation (RFC-004 Â§5.1). */
export const METRIC_AGGREGATION: Readonly<Record<MetricId, Aggregation>> = {
  impressions: 'sum',
  in_view: 'sum',
  game_started: 'sum',
  game_finished: 'sum',
  interactions: 'sum',
  hovered: 'sum',
  in_view_time: 'sum',
  dwell_time: 'sum',
  interaction_time: 'sum',
  dwell_avg_ms: 'weighted_avg',
  unique_impressions_reported: 'none',
  unique_clicks_reported: 'none',
}

/** Mirrors analytics.metric.weight_metric for the weighted averages. */
export const METRIC_WEIGHT: Readonly<Partial<Record<MetricId, MetricId>>> = {
  dwell_avg_ms: 'game_started',
}

export interface CanonicalDailyRow {
  date: IsoDate
  language: string
  /** Creative-level dimension; '' = untagged. */
  campaignTag: string
  /** Only the metrics the platform measures. Absent = not measured, never 0. */
  metrics: Partial<Record<MetricId, number>>
  pageViews: { pageId: string; count: number }[]
  ctaClicks: { ctaId: string; count: number }[]
  /** Events seen with no event_map entry, by vendor-supplied name. A Map, never a plain object. */
  unmapped: Map<string, number>
}

/** One third-party request/response pair, stored in external.raw_payload (already redacted). */
export interface RawCapture {
  request: { method: string; url: string; body?: unknown }
  response: unknown
  status: number
  fetchedAt: string
}

export interface FetchResult {
  rows: CanonicalDailyRow[]
  warnings: string[]
  /**
   * The days the connector actually queried and vouches for. The engine replaces EVERY day in
   * this window — a day with no rows is written as an empty slice, clearing what an earlier
   * run stored. `null` = nothing was queried (e.g. a window entirely after the newest complete day).
   */
  covered: DateWindow | null
}

export type EntityLevel = 'campaign' | 'creative' | 'pixel' | 'line_item' | 'placement' | 'order'

export interface SourceRecord {
  id: string
  displayName: string
  /** IANA zone in which this source's "day" is defined. Connectors must use it for "yesterday". */
  dayTimezone: string
  lookbackDays: number
  deepLookbackDays: number
  maxWindowDays: number
}

export interface LinkRecord {
  id: string
  campaignId: string
  sourceId: string
  credentialId: string
  language: string
  /** Raw jsonb as stored. Connectors read the validated `SyncContext.config` instead. */
  config: unknown
  enabled: boolean
}

export interface LinkEntity {
  level: EntityLevel
  externalId: string
  role: string | null
  label: string | null
  campaignTag: string
}

export interface EventMapEntry {
  eventName: string
  targetKind: 'metric' | 'page_view' | 'cta_click' | 'ignore'
  targetId: string | null
}

export interface Credential {
  id: string
  name: string
  /** Resolved from the env var named by external.credential.secret_env_var. */
  secret: string
  accountScope: Record<string, unknown>
}

/**
 * Per-run memo owned by the engine (or a scheduler pass). A connector may cache a response that
 * is identical for every link on the same credential â e.g. Zeus's unfiltered tracker report â
 * keyed by credential, report and window.
 */
export interface RunMemo {
  getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T>
}

export interface SyncContext<TConfig = unknown> {
  source: SourceRecord
  link: LinkRecord
  /** The link config, already validated against the connector's schema by the engine. */
  config: TConfig
  entities: LinkEntity[]
  eventMap: EventMapEntry[]
  credential: Credential
  window: DateWindow
  http: HttpClient
  log: Logger
  /** Aborted on shutdown; pass it to every request and check it between units of work. */
  signal: AbortSignal
  /** Persists a raw capture immediately, so failed runs keep the payloads worth debugging. */
  capture(raw: RawCapture): Promise<void>
  memo: RunMemo
}

export interface ConnectionContext {
  credential: Credential
  http: HttpClient
  log: Logger
  /** The source's day zone, for connectors that probe "yesterday". */
  dayTimezone: string
  signal?: AbortSignal
}

export interface SourceCapabilities {
  granularity: 'daily'
  /** Days after which a completed day may still be restated by the platform. */
  restatementWindowDays: number
  /** Largest window one API call may cover. */
  maxWindowDays: number
  /** Whether the platform reports range totals the run can be verified against. */
  verifiesAgainstTotals: boolean
}

export interface SourceIdentity {
  levels: readonly EntityLevel[]
  /** Several entities may sum into one campaign. */
  multiple: boolean
  roles?: Partial<Record<EntityLevel, readonly string[]>>
}

export interface ConnectionCheck {
  ok: boolean
  message: string
}

export interface SourceConnector<TConfig = unknown> {
  readonly id: string
  readonly capabilities: SourceCapabilities
  readonly identity: SourceIdentity
  /** Schema for external.campaign_link.config; the engine validates before every run. */
  describe(): { configSchema: ZodType<TConfig> }
  checkConnection(ctx: ConnectionContext): Promise<ConnectionCheck>
  fetchWindow(ctx: SyncContext<TConfig>): Promise<FetchResult>
}

/** Pure: payload in, canonical rows out, no I/O. */
export type Mapper<TInput> = (input: TInput) => CanonicalDailyRow[]

export function createRunMemo(): RunMemo {
  const entries = new Map<string, Promise<unknown>>()
  return {
    getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
      let entry = entries.get(key) as Promise<T> | undefined
      if (!entry) {
        entry = load()
        entries.set(key, entry)
        // A failed load is not cached: the next caller retries it.
        entry.catch(() => entries.delete(key))
      }
      return entry
    },
  }
}
