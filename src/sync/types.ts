import type { ZodType } from 'zod'
import type { DateWindow, IsoDate } from '../dates.ts'
import type { HttpClient } from '../http/HttpClient.ts'
import type { Logger } from '../log.ts'

// The whole platform-specific surface is one interface (SourceConnector) and one pure
// function (Mapper). Everything downstream speaks CanonicalDailyRow only (RFC-003 §3).

/** analytics.metric ids that are columns of analytics.advanced_analytics. */
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

export interface CanonicalDailyRow {
  date: IsoDate
  language: string
  /** Creative-level dimension; '' = untagged. */
  campaignTag: string
  /** Only the metrics the platform measures. Absent = not measured, never 0. */
  metrics: Partial<Record<MetricId, number>>
  pageViews: { pageId: string; count: number }[]
  ctaClicks: { ctaId: string; count: number }[]
  /** Events seen with no event_map entry, by name. */
  unmapped: Record<string, number>
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
  raw: RawCapture[]
  warnings: string[]
}

export type EntityLevel = 'campaign' | 'creative' | 'pixel' | 'line_item' | 'placement' | 'order'

export interface SourceRecord {
  id: string
  displayName: string
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

export interface SyncContext {
  source: SourceRecord
  link: LinkRecord
  entities: LinkEntity[]
  eventMap: EventMapEntry[]
  credential: Credential
  window: DateWindow
  http: HttpClient
  log: Logger
}

export type ConnectionContext = Pick<SyncContext, 'credential' | 'http' | 'log'>

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

export interface SourceConnector {
  readonly id: string
  readonly capabilities: SourceCapabilities
  readonly identity: SourceIdentity
  /** Schema for external.campaign_link.config; validated before every run. */
  describe(): { configSchema: ZodType }
  checkConnection(ctx: ConnectionContext): Promise<ConnectionCheck>
  fetchWindow(ctx: SyncContext): Promise<FetchResult>
}

/** Pure: payload in, canonical rows out, no I/O. */
export type Mapper<TInput> = (input: TInput) => CanonicalDailyRow[]
