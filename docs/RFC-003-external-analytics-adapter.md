# RFC-003: External Analytics Adapter

- **Status**: Draft · **Date**: 23.07.2026 · **Revised**: 27.08.2026 (Zeus/ATK connector + on-demand sync) · **Depends on**: [RFC-002](./RFC-002-standalone-analytics-app-supabase.md) §14
- Replaces the one-off script `backend/db_info_and_setup/nexd-migration/generate-nexd-sql.mjs`
- Zeus API reference: `https://t.zeus.ad/api/doc` (OpenAPI 3.0 at `/api/doc.json`)

Some creatives are served by third-party platforms that own the analytics. This adapter pulls those numbers into our own `analytics.*` tables on a schedule and on demand. **We implement two connectors — NEXD and Zeus (ATK)**; the structure is source-agnostic so the third platform is a connector, not a rewrite.

| Connector | What it gives us | Why we need it |
|---|---|---|
| **NEXD** (§1) | Full engagement analytics for NEXD-served creatives: impressions, viewable, engagement, dwell, per-page and per-CTA events | Those creatives carry `nexd.sendEvent` **instead of** our own instrumentation — without this connector we have no data at all for them |
| **Zeus** (§2) | Adserver delivery per campaign / creative / device, plus daily fire counts for our **ATK tracking pixels** (`loadATK`) | ATK is each campaign's default primary source (§4.1), and the ATK pixels are the engagement/finish signal the customer already sees in the Zeus UI |

The two are **not** the same kind of source, and §4.1 is the section that keeps that from silently corrupting the dashboard: NEXD measures traffic nobody else measures, Zeus re-measures traffic we already count ourselves.

---

## 1. How the NEXD sync works

The sync worker runs nightly and on demand (§5), as a module inside the ingestion service but off its public request path.

```
   nightly 04:00 ─┐
                  ├──►  Sync worker  ──►  api.nexd.com
   "Sync now" ────┘          │
                             ▼  transaction per (link, day)
                        Supabase Postgres
```

**Per campaign link, per run:**

1. **Resolve** — read the link: which `live_id`s, which language, which API key, which event map.
2. **Fetch** — `POST https://api.nexd.com/analytics/creatives/{live_id}` with `Authorization: Bearer <key>` and the documented `AnalyticsFilters` body (`base`, `startDate`/`endDate` as UNIX seconds, `traffic`, `device`). One request per `live_id`, chunked to **21-day windows**. Several `live_id`s (V1/V2/V3 variants) sum into one internal campaign.
3. **Map** — `performance[]` gives per-day metrics; per-day event counts give pages and CTAs:

   | Our column | NEXD source |
   |---|---|
   | `impressions` | `performance[].impressions` |
   | `in_view` | `performance[].viewable.value` (NEXD viewable = 50 % for **1.5 s**, stricter than IAB) |
   | `game_started` | `performance[].engagement.value` |
   | `interactions` / `hovered` | events `Unique [Touch]` / `Unique [Hover]` |
   | `dwell_time`, `in_view_time`, `interaction_time` | `performance[].dwell` × engagement ÷ 1000 (NEXD dwell is an **average** in ms; all three columns share it) |
   | `page_views` | events `Page seen [...]` → `page_id` |
   | `cta_clicks` | events `CTR [...]` → existing generic `cta_id` |
   | `game_finished` | not supported → 0 |

   Mapping is unchanged from the validated `nexd-migration/MAPPING.md`; what changes is that `liveIds`/`pageMap`/`ctaMap` move from script `CONFIG` into DB rows.
4. **Write** — for each day, in one transaction: `DELETE` that day's external rows, then `INSERT` the fresh ones (§4).
5. **Verify** — sum the written days against NEXD's own `summary.totals`; a mismatch fails the run. Events with no mapping are archived and surfaced as "map this" in the admin UI.

**Window:** every run re-pulls the last **7 days**, plus a weekly deep re-pull of **35 days**. Ad platforms revise past days after the fact (CM360 documents 30 days, DV360 31); NEXD's behaviour is undocumented, so we re-sync defensively. Backfill is the same code path with an operator range: `npm run sync -- --link <id> --from … --to … [--dry-run]`.

### Two NEXD-specific catches

- **`eventsList` is undocumented.** The per-day event object the script relies on is not in NEXD's OpenAPI spec — only the range-total `events[]` is. So the connector has a fallback strategy (one request per day, reading the documented `events[]`), switches to it automatically if `eventsList` goes missing, and a contract test fails CI if it disappears — rather than the dashboard silently zeroing.
- **Chunk at 21 days.** NEXD's spec says bucketing coarsens on longer ranges. We chunk small and assert the returned rows are one day apart.

---

## 2. How the Zeus (ATK) sync works

Zeus is the adserver behind our **ATK** pixels — the `loadATK(customer, checksum, creativeId, page)` call the creatives already fire at game start and game finish. Its reporting API (`https://t.zeus.ad/api/doc`, OpenAPI 3.0) is far simpler than NEXD's: **four read-only GET endpoints, all daily aggregates, Bearer token, no report-job lifecycle.**

```
GET https://t.zeus.ad/api/v1/reports/{campaigns|creatives|devices|tracker}
    ?from=YYYY-MM-DD&to=YYYY-MM-DD[&internal_id=…|&external_id=…]
Authorization: Bearer <per-customer token>
```

Every response is `{ customer, from, to, rows[] }`. Both date params are inclusive and default to yesterday.

### 2.1 The two facts that shape the connector

- **Yesterday is the newest day that exists.** The spec is explicit: *"All figures are daily aggregates and only cover complete days — the latest available day is always yesterday,"* and `to` is silently **clamped** to yesterday. There is no intraday data at any refresh rate. The nightly cron is therefore not a cost optimisation, it is the only cadence the API supports, and the on-demand button (§5) can only ever re-pull *completed* days.
- **One token, ours.** The spec calls it a "per-customer API token", and the creatives pass varying `customer` numbers to `loadATK` (`317`, `465`, `29`) — but those are Zeus's identifiers for campaigns/clients *within our own account*, not separate Zeus accounts. **We hold a single Zeus token covering all of them** (as we do a single NEXD key), so the connector has one credential row, not one per client. Worth confirming on the first call: if the token turns out to see only one of those `customer` values, `credential.account_scope` (§3.1) already absorbs a second account without a schema change.

### 2.2 Per campaign link, per run

1. **Resolve** — read the link's `link_entity` rows. Zeus needs up to three levels: `campaign`, `creative` (delivery), and **`pixel`** (the ATK fires). Pixels are a *parallel* entity, not a child of the creative — see §3.1.
2. **Fetch** — three GETs per window, one per report we consume, chunked to **31-day** windows (the spec documents no maximum range and no pagination, so we chunk conservatively and assert the returned `rows` cover exactly the requested days):

   | Endpoint | Used for | Filter |
   |---|---|---|
   | `/reports/creatives` | delivery, per creative per day | `external_id`, falling back to `internal_id` |
   | `/reports/tracker` | ATK fires, per pixel per day | left unfiltered — see below |
   | `/reports/devices` | device split (§2.4) | `external_id` / `internal_id` |

   All four endpoints take the same `internal_id` / `external_id` pair, but each filters **a single id of its own entity type** — on `/reports/tracker` that is one *pixel*, not a campaign. Since a campaign has at least two ATK pixels (engagement and finish), filtering would mean one request per pixel; we instead fetch the token's pixels unfiltered once per window and match rows against `link_entity` locally. That also gives the `--list-pixels` discovery output of §2.3 for free.

   `/reports/campaigns` is the same numbers as `/reports/creatives` without the creative dimension — we fetch it only when a link has no creative-level entity.
3. **Map** —

   | Our column | Zeus source |
   |---|---|
   | `impressions` | `/reports/creatives` → `rows[].impressions` |
   | `in_view` | `rows[].visible_impressions` |
   | `cta_clicks` (generic `cta_id`) | `rows[].clicks` |
   | `unique_users_reported` | `rows[].unique_impressions` — scalar, **never summed** (§4) |
   | `unique_clicks_reported` | `rows[].unique_clicks` — same rule |
   | `game_started` | `/reports/tracker` → `fires` on the link's **engagement** ATK pixel |
   | `game_finished` | `/reports/tracker` → `fires` on the link's **finish** ATK pixel |
   | `ctr`, `visibility` | **not stored.** They are percentages derived from the two counts above; storing a ratio makes `SUM()` across days and creatives wrong. Recomputed at read time. |
   | `dwell_time`, `in_view_time`, `interaction_time`, `interactions`, `hovered`, `page_views` | not supported by Zeus |

   Unsupported metrics are **omitted** from `metrics`, not written as `0` — the connector's `capabilities.metrics` tells the dashboard to render "—". A zero here would read as "nobody interacted" rather than "this platform does not measure it".
4. **Write** — identical to NEXD: atomic day replace under the per-link advisory lock, `source = 'zeus'` (§4).
5. **Verify** — Zeus returns no range-total object to check against (unlike NEXD's `summary.totals`), so the run instead asserts internal consistency: `clicks ≤ impressions`, `visible_impressions ≤ impressions`, `unique_impressions ≤ impressions`, and every requested day present exactly once. A violated invariant fails the run rather than writing it.

### 2.3 Matching ATK pixels to campaigns — the one real unknown

`/reports/tracker` rows carry `pixel_id` (int), `external_id`, `code` (string), `name` (string) and `fires`. Our ATK call carries `customer`, `checksum` (`"1823ca"`), `creativeId` (`"engswipe"`) and `page`. **Which Zeus field the `checksum` and the `creativeId` correspond to cannot be determined from the spec** — it documents neither field's format — and it is the single blocking unknown for this connector.

Two consequences, both cheap:

- **The connector does not guess.** A pixel is resolved against `link_entity` by `code`, then `external_id`, then `name`; whichever field turns out to hold our identifier, the same rows work with no code change. Pixels matching none of them are recorded in `unmapped` and surface in the admin UI as "map this" — the same path NEXD's unmapped events already take.
- **Onboarding is a discovery call, not a lookup.** The first thing the connector ships with is `npm run sync -- --source zeus --list-pixels`, which prints the token's whole pixel list. An operator maps engagement/finish once per campaign in the admin UI. Resolve this against a real token before writing the mapper (§7).

**Operational recommendation:** ask whoever provisions Zeus campaigns to set the campaign's **`external_id` to our internal campaign UUID**. Zeus falls back to its own id when unset, so this is free, and it turns the campaign link from a hand-maintained mapping into a self-describing one. It does not solve the pixel question above — pixels are provisioned separately.

### 2.4 Device breakdown — deliberately not in the canonical rows

`/reports/devices` gives desktop / mobile / tablet splits. `analytics.*` has **no device dimension**, and adding one to every rollup table to satisfy a single source would be the tail wagging the dog. It lands instead in a source-owned table:

```sql
CREATE TABLE external.device_daily (
  link_id     uuid NOT NULL REFERENCES external.campaign_link(id) ON DELETE CASCADE,
  source_id   text NOT NULL REFERENCES external.source(id),
  events_date date NOT NULL,
  device_type text NOT NULL,                    -- desktop | mobile | tablet | '' (unknown)
  impressions bigint NOT NULL DEFAULT 0,
  clicks      bigint NOT NULL DEFAULT 0,
  visible_impressions bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, events_date, device_type)
);
```

Written by the same day-replace transaction, read by one dashboard panel. If a second and third source later report devices the same way, that is the moment to promote it into `analytics.*` — not before.

---

## 3. What makes it abstract

The whole platform-specific surface is one interface and one pure function.

```ts
interface SourceConnector<TConfig> {
  readonly id: string                              // 'nexd' | 'zeus'
  readonly capabilities: SourceCapabilities        // granularity, dwell semantics,
                                                   // restatement window, max window
  describe(): { configSchema: object }             // admin UI renders + validates the form
  checkConnection(ctx): Promise<{ ok: boolean }>   // credential probe
  fetchWindow(ctx: SyncContext<TConfig>): Promise<SyncResult>
}

type Mapper<TPayload> = (payload: TPayload, ctx) => CanonicalDailyRow[]   // pure, no I/O
```

Everything downstream speaks only **canonical rows**:

```ts
interface CanonicalDailyRow {
  date: string; language: string; campaignTag: string | null
  metrics:   Partial<Record<CanonicalMetric, number>>   // impressions, inView, gameStarted, …
  pageViews: Array<{ pageId: string; count: number }>
  ctaClicks: Array<{ ctaId: string; count: number }>
  unmapped:  Record<string, number>                     // seen but unmapped events
}
```

The sync engine, writer, scheduler and admin UI never know NEXD or Zeus exists. Supporting pieces that stay generic:

- **`ReportJob` seam** (`submit` → `poll` → `fetch`, with framework-owned backoff). NEXD and Zeus are both synchronous and use a one-line `immediateJob()`; CM360, DV360, Adform and Equativ all use the async report-job lifecycle and drop straight in.
- **Multi-endpoint fetches are the connector's business.** Zeus needs three GETs to build one day (§2.2), NEXD needs one POST. `fetchWindow` returns `CanonicalDailyRow[]` either way, so nothing downstream changes.
- **Shared `HttpClient`** — retries, backoff, per-credential rate limiting, and `Authorization` redaction in logs.
- **Opaque cursor per link**, committed only *after* the analytics write commits, so a crashed run is safely re-runnable.
- **Config in the DB, not in code** — lookback/rollback/chunk sizes live on the `external.source` row per platform.

### Schema (schema `external`)

| Table | Holds |
|---|---|
| `source` | Known platforms + their lookback / rollback / max-window defaults; also the registry `app.campaign.primary_source` points into — `'brame'` is seeded as a pseudo-source row (§4.1) |
| `credential` | A *pointer* to a secret (env var / Vault key), never the secret — plus the platform's **account scope** |
| `campaign_link` | internal campaign ⟷ one external identity: language, timezone, connector config |
| `link_entity` | The external IDs themselves — one row per referenced entity (§3.1) |
| `event_map` | external event *name* → `metric` / `page_view` / `cta_click` target (replaces `pageMap`/`ctaMap`). NEXD only — Zeus has no named events inside a payload; its ATK pixels are **entities**, mapped by `link_entity.role` (§3.1) |
| `device_daily` | Zeus device split — source-owned, outside `analytics.*` (§2.4) |
| `sync_state` | Opaque cursor + high-water date |
| `sync_run` | Run log: trigger (`cron` / `manual`), window, status, counts, warnings, errors |
| `raw_payload` | Raw responses for replay/debug, purged at 30 days |

Service-role only; admin screens go through `SECURITY DEFINER` functions with the usual company scoping.

### 3.1 External identity — the generic `live_id`

Every platform has an equivalent of NEXD's `live_id`, but never as a single value. Three separable things:

| Platform | Account scope (→ `credential`) | Entity IDs (→ `link_entity`) |
|---|---|---|
| **NEXD** | the API key itself | `live_id` per published creative |
| **Zeus** | our single company token (§2.1) | campaign id, creative id, **pixel id** — three levels, and the pixels are a parallel stream, not children of the creative |
| Adnuntius | `context` = network ID | `lineItemId`, `creativeId` |
| Adform | client of the OAuth app | campaign / order / line item / banner |
| Celtra | account ID | campaign / creative / placement |
| CM360 | `profileId` | advertiser / campaign / placement / creative |

So identity is modelled as **account scope on the credential** + a **list of typed entity references** on the link:

```sql
ALTER TABLE external.credential ADD COLUMN account_scope jsonb NOT NULL DEFAULT '{}';
--   NEXD: {}   ·   Zeus: {} (one company-wide token, §2.1)
--   Adnuntius: {"networkId": "..."}   ·   CM360: {"profileId": "..."}

CREATE TABLE external.link_entity (
  link_id     uuid NOT NULL REFERENCES external.campaign_link(id) ON DELETE CASCADE,
  source_id   text NOT NULL REFERENCES external.source(id),   -- denormalized from the link,
                                                              -- so the index below can be unique
  level       text NOT NULL,     -- 'creative' | 'line_item' | 'campaign' | 'order'
                                 -- | 'placement' | 'pixel'
  external_id text NOT NULL,
  role        text,              -- within a level: Zeus pixels are 'engagement' | 'finish'
  PRIMARY KEY (link_id, level, external_id)
);
-- Reverse lookup + duplicate detection:
CREATE UNIQUE INDEX ON external.link_entity (source_id, level, external_id);
```

Three reasons this is a table and not `external_ids jsonb`:

- **Push ingress needs reverse lookup.** An Adnuntius `dataexport` arrives keyed by *their* creative ID; we must resolve it to an internal campaign. That is an indexed lookup, not a jsonb scan.
- **Duplicate detection.** The unique index catches "this creative is already linked to another campaign" — today a silent double-count.
- **One admin UI.** The connector declares its levels; the form renders the same way for every source.

The connector declares what it needs, so nothing source-specific reaches the engine:

```ts
// NEXD
readonly identity = {
  levels: ['creative'] as const,        // NEXD reports at creative level
  multiple: true,                       // several live_ids sum into one campaign
  accountScopeSchema: {},               // NEXD needs none; Adnuntius requires networkId
}

// Zeus
readonly identity = {
  levels: ['campaign', 'creative', 'pixel'] as const,
  multiple: true,
  roles: { pixel: ['engagement', 'finish'] },        // renders the ATK mapping form
  accountScopeSchema: {},                            // one company-wide token (§2.1)
}
```

**Many-to-one is the default, not an edge case** — several `live_id`s already merge into one internal campaign, so the engine always sums entity metrics for a day before writing (and aborts the day if any entity fetch fails, rather than writing an undercount).

**Summing is per level, never across levels.** Zeus makes this explicit: summing a campaign's creatives gives its delivery, but adding the pixel fires on top would be nonsense. The engine sums within a level and lets the mapper decide which level feeds which canonical metric.

**Not identity: report artifacts.** CM360's `reportId` and DV360's `queryId` are created *by* the connector and change over time — they live in the `sync_state` cursor, never in `link_entity`.

---

## 4. The one rule that shapes everything: replace, don't increment

Our own ingestion writes `counter = counter + 1`. External sources **restate history** — yesterday's number can change next week — so a sync must overwrite. Two writers with opposite semantics cannot share a row.

So every rollup table gains a `source` column inside its natural key:

```sql
ALTER TABLE analytics.advanced_analytics ADD COLUMN source text NOT NULL DEFAULT 'brame';
-- unique key becomes (campaign_id, campaign_tag, language, events_date, source)
-- same for page_views (+page_id), cta_clicks (+cta_id), ad_impressions
```

The sync worker only ever touches `source <> 'brame'`; the ingestion service only `'brame'`. How the dashboard then combines them is **not** uniform — see §4.1.

**Write = atomic day replace**, not upsert:

```sql
SELECT pg_advisory_xact_lock(hashtext($link_id));       -- one writer per link
DELETE FROM analytics.advanced_analytics
 WHERE campaign_id=$1 AND source=$2 AND language=$3 AND events_date=$4;
INSERT INTO analytics.advanced_analytics (...) VALUES (...);
```

An upsert corrects rows that still exist but cannot remove a key that *disappeared* from the source — a restated day that drops a CTA would leave a stale `cta_clicks` row forever. Replacing the day's whole slice converges to the source's truth; the `source` predicate makes it structurally unable to touch live rows. Because several `live_id`s sum into one row, a partial fetch failure aborts the day rather than writing an undercount.

> One consequence: platform-reported unique counts land in a scalar `unique_users_reported` column, not RFC-002's `hll` column — they can't be merged across days, so the read layer must never sum them.

### 4.1 One primary source per campaign — why `SUM()` across sources is wrong

Adding Zeus exposed an assumption the NEXD-only design got away with. **Not every source measures traffic no other source sees:**

| Source | Relationship to `'brame'` rows |
|---|---|
| `nexd` | NEXD-served creatives ship `nexd.sendEvent` **instead of** our instrumentation, so no `'brame'` row exists for that traffic |
| `zeus` | The ATK pixel and the adserver count **the same impression** our own instrumentation already counted |

A creative firing `loadATK` at game start also calls our own `gameStarted()` on the same interaction. Summing `'brame'` + `'zeus'` would report every game start twice — and would do it silently, looking like a good month rather than a bug.

An earlier revision solved this with a per-source `combine_mode` (`additive` / `parallel`): additive sources summed into a composite headline, parallel ones rendered beside it. **That design is superseded.** The business ranking is now explicit — **ATK (Zeus) is the main source; NEXD and our own instrumentation are checks** — and no campaign genuinely splits its traffic across serving platforms, so a composite sum never describes anything real. The model collapses to a declaration per campaign:

```sql
ALTER TABLE app.campaign ADD COLUMN primary_source text NOT NULL
  REFERENCES external.source (name);   -- 'zeus' (ATK) | 'nexd' | 'brame' (Custom)
```

(`'brame'` is seeded into the `external.source` registry as a pseudo-source row so the FK covers it — and so source #4 is a seed row, not an enum migration.)

- **The headline is the primary source's rows, and nothing else.** No figure is ever summed across sources — the double-counting class of bug is gone by construction, not by arithmetic.
- **Every other source renders as its own labelled check series** next to the headline (the dashboard's source switcher / Compare view). This is a feature, not a consolation: "our count vs the adserver's count" is exactly the discrepancy an account manager gets asked about, and today it is a manual comparison between two dashboards. A source with no data for the campaign shows greyed out as "no data" rather than hidden — that too is a check result.
- **Every `get_*` read function resolves the campaign's primary** for its headline figures and takes an optional source override for the switcher. RFC-002 §14.2's per-source rules ride along: platform-reported uniques are never `SUM()`ed, HLL merges apply to `'brame'` rows only.
- **Assignment:** new campaigns choose `primary_source` at provisioning — required, with a validation warning when the chosen primary has no configured link/pixel (that campaign would render an empty dashboard). Existing and backfilled campaigns get a one-time assignment: `zeus` where an ATK link exists, else `nexd` where a NEXD link exists, else `brame` — which leaves the RFC-002 §13 backfill looking exactly as before, since legacy rows are all `'brame'`.
- **Freshness is the accepted cost.** A `zeus` or `nexd` primary is complete only through yesterday (RFC-002 §14.1); the dashboard shows the headline's `data_complete_through`, and an operator who needs fresher completed days runs "Sync now". The `'brame'` check series stays real-time.

`external.source.combine_mode` and its `campaign_link` override are dropped from the schema.

---

## 5. Scheduling and on-demand runs

**One code path, two triggers.** `runSync(linkId, window, trigger)` is the whole entry point; the nightly job and the button differ only in who calls it and what window they pass.

| Trigger | Window | Notes |
|---|---|---|
| **Nightly, 04:00 Europe/Zurich** | Standard lookback: 7 days, plus a 35-day deep re-pull weekly (§1) | All active links, all sources, sequential per credential to respect rate limits |
| **On demand — "Sync now"** | Same 7-day lookback by default; an operator range for backfills | Per link, from the campaign detail page |

**Where it runs: a `sync/` module inside the ingestion service** (RFC-002 §6.2), not a service of its own and not a Render Cron Job.

- **Not its own service**, because the workload is kilobytes of JSON over tens of links and almost entirely I/O wait — it does not repay a second deploy target, env-var set and health check. RFC-002 §14.1 carries the full argument and the three obligations it creates (leader lock, capped pool share, sync failures kept out of `/readyz`).
- **Not a Render Cron Job**, because a cron container only exists while it runs and so cannot answer the on-demand trigger; wiring the button to Render's "trigger a cron run" API would give us no run id, no progress, and deploy-scoped rather than user-scoped auth.

An always-on service we already operate gives us the schedule (`node-cron`, behind the leader lock) *and* the trigger endpoint, with one scheduler and one code path. The module is self-contained with a single entry point, so if a future connector turns out to need minutes of CPU, lifting it into its own service is a deploy-config change rather than a rewrite.

**The trigger endpoint:**

```
POST /sync/links/:linkId/run   { from?, to?, dryRun? }
  → 202 { syncRunId }          the UI polls external.sync_run for status
```

Authenticated with the caller's Supabase token and company-scoped exactly like RFC-002's `/export-csv` (§6.7): a company admin may only sync their own campaigns' links, a super-admin any of them. Every run records `triggered_by` and `trigger = 'manual'` in `sync_run`, so a surprising number in the dashboard can always be traced to who re-pulled what.

**Guardrails:**

- **Concurrency is already solved.** `pg_advisory_xact_lock(link_id)` (§4) means a manual run racing the nightly one waits rather than interleaving, and because writes are whole-day replaces the loser simply rewrites identical days.
- **Cooldown per link** (`external.source.min_manual_interval`, default 5 min) returns `429` rather than letting an impatient operator hammer a third-party API on a shared token.
- **A `dryRun` produces a diff, not a write** — the same flag the CLI backfill uses.

**What on-demand cannot do, and the UI must say so:** Zeus has no data newer than yesterday (§2.1) and NEXD restates past days on an undocumented schedule. "Sync now" re-pulls *completed* days; it never surfaces today's traffic. The button is labelled for what it does — *Re-sync last 7 days* — with the link's `last_synced_at` next to it, so nobody reads a click as a live refresh.

---

## 6. Adding the next source

Concretely, **Adnuntius** (heute.at already serves our fireplace creatives there):

| Work | Effort |
|---|---|
| `AdnuntiusConnector` — API key as Bearer, `GET /api/v1/stats?context=…&creativeId=…&timeZone=…` | ~1 d |
| `adnuntiusMapper` — impressions/rendered/visibles/viewables/clicks + custom events → canonical | ~0.5 d |
| Seed `external.source` row, register in the connector registry | minutes |
| Fixtures + mapper tests | ~0.5 d |
| **Engine, writer, schema, scheduler, admin UI** | **no change** |

Adnuntius also supports scheduled **push** (`/v1/dataexports` → daily stats to S3/SFTP/webhook). That fits the same seam: a webhook route parses the export and hands `CanonicalDailyRow[]` to the same writer. The interface is about *producing canonical rows*; ingress shape is the connector's business.

Same story for **Adform** (OAuth2 client credentials + async report jobs, has engagement + avg-engagement-time) and **Celtra** (Basic auth, closest metric taxonomy to NEXD). No public analytics API: Bannerflow, Clinch, Airtory, Bonzai, Adition.

Connectors also die — Amazon Ad Server shut down end-2024, Xandr's DSP closes Feb 2026 — so connectors stay mutually independent and **all synced history lives in our Postgres permanently**.

---

## 7. Open points

**Ask NEXD support** (with the API-key request): rate limits, restatement window, retention, whether `performance[].date` follows the campaign's `analytics_timezone`, and whether `eventsList` is supported.

**Ask Zeus support** (with the token request) — the spec answers none of these:

1. **Which tracker field carries our ATK identity** — does `code` hold the `checksum` (`"1823ca"`) or the `creativeId` (`"engswipe"`)? **Blocking for the mapper** (§2.3); everything else has a safe default.
2. **What timezone a "day" is.** RFC-002 buckets on `Europe/Zurich`; if Zeus days are UTC we either accept a ±1-day edge (as the legacy backfill does, RFC-002 §13.3) or shift on write. Cheap to answer, expensive to discover later.
3. **Restatement** — are completed days ever revised? If never, the 7-day lookback collapses to a 1-day pull and the nightly run gets much cheaper.
4. **Rate limits and max range**, so the 31-day chunk and the per-credential throttle are calibrated rather than guessed.
5. **`visible_impressions` definition** — which viewability standard (IAB 50 % / 1 s?). It sits in the same `in_view` column as NEXD's stricter 50 % / 1.5 s, so the dashboard must footnote whichever it is.
6. **Retention** — how far back the API serves, which bounds any historical backfill.

**Ours to decide:**
1. Do external rows survive RFC-002's 1-year purge? As written, a backfill older than a year is deleted the same night.
2. Confirm `dwellMode = total_seconds` (avg × engagement) — MAPPING.md's open question.
3. ~~Dashboard: combine sources silently, or show a breakdown?~~ **Decided in §4.1** — each campaign declares a `primary_source` (ATK / NEXD / Custom); the headline shows only that source, and every other source renders as a labelled check series. Nothing is ever summed across sources.
4. Does the operational ask in §2.3 stick — will Zeus campaigns be provisioned with `external_id` = our internal campaign UUID? If not, campaign links stay a hand-maintained mapping.

**Estimate:** ~17 working days for the framework + NEXD (unchanged), **+ ~6 days for Zeus and on-demand**:

| Work | Effort |
|---|---|
| `ZeusConnector` — 3 GET reports, 31-day chunking, `--list-pixels` discovery | ~1.5 d |
| `zeusMapper` + pixel/role resolution + consistency assertions | ~1 d |
| `primary_source` — column + seed rows, one-time assignment for existing campaigns (`zeus` → `nexd` → `brame`), and the `get_*` read functions that resolve it (§4.1) | ~1 d |
| `sync/` module — scheduler + leader lock, trigger endpoint, auth, cooldown, capped pool share | ~1 d |
| Admin UI: "Sync now" + run status, pixel mapping form, `device_daily` panel | ~1 d |

Migration off the script is its own acceptance test — run `--dry-run` over an already-migrated range and diff against what the script wrote. Zeus has no equivalent baseline, so its acceptance test is a manual reconciliation of one campaign-week against the Zeus UI before the connector is trusted.
