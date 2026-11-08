import type { ZodType } from 'zod'
import type { DateWindow, IsoDate } from '../../core/dates.ts'
import type { HttpClient } from '../../core/http/HttpClient.ts'
import type { Logger } from '../../core/log.ts'

// The whole platform-specific surface is one interface (SourceConnector) and one pure
// function (Mapper). Everything downstream speaks CanonicalDailyRow only (RFC-003 Â§3).

/**
 * analytics.metric ids that are columns of analytics.advanced_analytics, in the column order of
 * src/modules/sync/sql/insert_advanced.sql. An integration test pins both this order and the
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

// --- provisioning capabilities (phase 2) -------------------------------------------------------
//
// A connector may do more than read: it may tell us the ids another platform must be given for a
// campaign we set up (Zeus: the strings ATK sets as external ids), and later create things on its
// platform. Both are optional capabilities checked with the type guards below, so the campaigns
// service knows no platform by name here either.

/** One creative of a campaign as the connectors see it (app.creative). */
export interface CreativeHandle {
  id: string
  /** What its analytics rows carry. */
  tag: string
  type: string | null
  name: string
}

/**
 * A thing a platform created for us and handed an id back for (external.provisioned_resource):
 * the sync never asks for it, the connectors that derive ids may read it.
 */
export interface ProvisionedResourceRecord {
  source: string
  /** The connector's word: 'campaign', 'creative', 'publish' … */
  kind: string
  externalId: string
  /** The creative it belongs to; null for a campaign-level resource. */
  creativeId: string | null
}

export interface ExternalIdInput {
  campaign: {
    id: string
    name: string
    /** The CRM's reference, e.g. salesforce / 006Rp00000ABCDE. */
    externalRef: { system: string; id: string } | null
  }
  creatives: readonly CreativeHandle[]
  resources: readonly ProvisionedResourceRecord[]
}

/** An id another platform must be told, and what it names. */
export interface DerivedExternalId {
  level: 'campaign' | 'creative'
  /** The creative it names; null for the campaign's own id. */
  creativeId: string | null
  externalId: string
}

/**
 * Derives, from what we know about a campaign, the ids this connector's platform must be given
 * for it. Pure: it derives what it can and leaves out what it cannot yet (a creative another
 * platform has not created), so the result grows as the campaign is provisioned.
 */
export interface ExternalIdDeriver {
  deriveExternalIds(input: ExternalIdInput): DerivedExternalId[]
}

export function derivesExternalIds(
  connector: SourceConnector,
): connector is SourceConnector & ExternalIdDeriver {
  return typeof (connector as Partial<ExternalIdDeriver>).deriveExternalIds === 'function'
}

/** What a provisioning step may use: the credential, two clients, a sink for raw responses. */
export interface ProvisionContext {
  credential: Credential
  /** Retries transient failures, like every other outbound call. */
  http: HttpClient
  /** No retries: for polling an endpoint whose "not yet" answer is a retryable status (NEXD's 408). */
  httpNoRetry: HttpClient
  log: Logger
  signal?: AbortSignal
  /** Persists a (redacted) request/response pair as it happens, so a failed run keeps them. */
  capture?: (raw: RawCapture) => Promise<void>
  /** Injectable for tests. */
  sleep: (ms: number) => Promise<void>
  now?: () => Date
}

/** A thing the platform created, as the connector names it; stored as a provisioned resource. */
export interface NewResource {
  kind: string
  externalId: string
}

export interface ProvisionCampaignInput {
  campaign: ExternalIdInput['campaign']
  /** This platform's campaign-level resources so far: a step already done is not done twice. */
  existing: readonly ProvisionedResourceRecord[]
}

export interface ProvisionCreativeInput {
  campaign: ExternalIdInput['campaign']
  /** This platform's campaign-level resources (its campaign id among them). */
  campaignResources: readonly ProvisionedResourceRecord[]
  creative: CreativeHandle
  /** This platform's resources for this creative so far. */
  existing: readonly ProvisionedResourceRecord[]
}

export interface ProvisionedStep {
  /** New resources this step created; the caller stores them before anything else happens. */
  resources: NewResource[]
  warnings: string[]
}

export interface ProvisionedCreative extends ProvisionedStep {
  /**
   * The id the sync will ask the platform for (the creative-level link entity), once the
   * platform has it; null while it does not yet.
   */
  entity: { externalId: string; label: string } | null
}

/**
 * Creates a campaign and its creatives on the connector's platform. Every step is resumable: it
 * reads what already exists (`existing`) and does only what is missing, so a run that failed
 * halfway can be run again without creating a second campaign.
 */
export interface Provisioner {
  provisionCampaign(ctx: ProvisionContext, input: ProvisionCampaignInput): Promise<ProvisionedStep>
  provisionCreative(
    ctx: ProvisionContext,
    input: ProvisionCreativeInput,
  ): Promise<ProvisionedCreative>
}

export function provisions(connector: SourceConnector): connector is SourceConnector & Provisioner {
  const candidate = connector as Partial<Provisioner>
  return (
    typeof candidate.provisionCampaign === 'function' &&
    typeof candidate.provisionCreative === 'function'
  )
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
