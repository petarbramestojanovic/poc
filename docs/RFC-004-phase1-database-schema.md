# RFC-004: Phase 1 database schema (webhook-only iteration)

- **Status**: Draft · **Date**: 12.09.2026 · **Author**: Petar Stojanovic
- **Depends on**: [RFC-002](./RFC-002-standalone-analytics-app-supabase.md) §7, §14, §15 · [RFC-003](./RFC-003-external-analytics-adapter.md)
- **Scope**: the tables phase 1 (NEXD + Zeus/ATK sync → client webhook) needs, designed so phase 2 (own ingestion, dashboard, backfill) only **adds** — no key, column or semantic changes.

---

## 1. Principles that make phase 2 additive

| # | Rule | Why it cannot wait |
|---|---|---|
| 1 | Every rollup's primary key is `(campaign_id, source, language, campaign_tag, events_date [, page_id / cta_id])` — natural key, no serial `id` | Rebuilding a unique key later drops every constraint the phase-2 `ON CONFLICT` upserts rely on |
| 2 | `campaign_id` is `uuid REFERENCES app.campaign` everywhere | Phase 1 has no creative sending text ids; phase-2 ingestion maps the text id via `app.campaign.legacy_campaign_id` |
| 3 | Metric columns are **nullable, no `DEFAULT 0`** — `NULL` = *not measured by this source* | A stored `0` can never be told apart from "absent" afterwards |
| 4 | Metric names + units are frozen by the `analytics.metric` catalog; new metrics are new rows + new columns, never renames | The webhook payload and the phase-2 dashboard read the same column names |
| 5 | `source` is a FK into `external.source`, with `'brame'` seeded as a pseudo-source | A fourth platform is a seed row, not a migration |
| 6 | `events_date` is *the source's day* in `external.source.day_timezone`; own rows use `Europe/Zurich` | Cross-source day skew is accepted and declared, not silently re-bucketed |
| 7 | `campaign_tag` is the **creative-level** dimension (`''` = untagged). Within one `(campaign, source)` either every row is tagged or none is | Mixing tagged and untagged rows for one source double-counts on `SUM` |
| 8 | `language` on external rows comes from the link; `''` = not split | NEXD and Zeus are not language-aware |
| 9 | Key text columns are `NOT NULL DEFAULT ''`, never `NULL` | `NULL`s are distinct in unique indexes and break `ON CONFLICT` |
| 10 | Every read the webhook needs is a **Postgres function**; the service only calls them | Phase 2's dashboard calls the same functions via `supabase.rpc()` |

---

## 2. Overview

```
 app                          analytics                          external
 ───                          ─────────                          ────────
 company ─┬─ campaign ────────┬─ advanced_analytics              source ──┬─ source_metric
          │     │             ├─ page ── page_views                       ├─ credential
          │     │ primary_    ├─ cta  ── cta_clicks                       │
          │     │ source ─────┼───────────────────────────────────────────┘
          │     │             └─ metric (catalog) ◄── source_metric
          │     └──────────────────────────────────────── campaign_link ─┬─ link_entity
          ├─ webhook ── webhook_delivery                                  ├─ event_map
          └─ (phase 2: user, audit_log)                                   ├─ sync_state
                                                                          ├─ sync_run ── raw_payload
                                                                          └─ unmapped_event
```

Creation order matters because of cross-schema FKs: `external.source` → `app.*` → `analytics.metric` → `analytics.*` → rest of `external.*`.

---

## 3. Schema `external` — sources and credentials (created first)

```sql
CREATE SCHEMA external;

-- Registry of everything that can produce analytics rows. 'brame' = our own instrumentation.
CREATE TABLE external.source (
  id                   text PRIMARY KEY,                      -- 'brame' | 'nexd' | 'zeus'
  display_name         text NOT NULL,                         -- 'Custom', 'NEXD', 'ATK (Zeus)'
  kind                 text NOT NULL CHECK (kind IN ('own', 'platform')),
  day_timezone         text NOT NULL,                         -- what "a day" means for this source (IANA)
  lookback_days        int  NOT NULL DEFAULT 7,               -- re-pulled every run (restatements)
  deep_lookback_days   int  NOT NULL DEFAULT 35,              -- weekly deep re-pull
  max_window_days      int  NOT NULL DEFAULT 21,              -- chunk size per API call
  min_manual_interval  interval NOT NULL DEFAULT '5 minutes', -- "Sync now" cooldown
  enabled              boolean NOT NULL DEFAULT true
);

INSERT INTO external.source (id, display_name, kind, day_timezone, lookback_days, deep_lookback_days, max_window_days) VALUES
  ('brame', 'Custom',      'own',      'Europe/Zurich', 0, 0,  0),
  ('nexd',  'NEXD',        'platform', 'UTC',           7, 35, 21),   -- TZ: confirm analytics_timezone (RFC-003 §7)
  ('zeus',  'ATK (Zeus)',  'platform', 'UTC',           7, 35, 31);   -- TZ: unknown, ask Zeus (RFC-003 §7)

-- A *pointer* to a secret, never the secret (RFC-002 §14.4). Values live in Render env vars.
CREATE TABLE external.credential (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       text NOT NULL REFERENCES external.source(id),
  name            text NOT NULL,                              -- 'brame-main'
  secret_env_var  text NOT NULL,                              -- 'NEXD_API_KEY', 'ZEUS_API_TOKEN'
  account_scope   jsonb NOT NULL DEFAULT '{}',                -- NEXD/Zeus: {} ; Adnuntius: {"networkId": ...}
  enabled         boolean NOT NULL DEFAULT true,
  last_checked_at timestamptz,
  last_check_ok   boolean,
  UNIQUE (source_id, name)
);
```

---

## 4. Schema `app` — companies, campaigns, webhooks

```sql
CREATE SCHEMA app;

CREATE TABLE app.company (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  legacy_company_id  text UNIQUE,                             -- Brame parent-app id, for the RFC-002 §13 backfill
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.campaign (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES app.company(id),
  name                text NOT NULL,                          -- 'AT2608 Tchibo Caffè Crema'
  legacy_campaign_id  text UNIQUE,                            -- the text id creatives send today; backfill + phase-2 ingestion map through it
  primary_source      text NOT NULL REFERENCES external.source(id),  -- headline source (RFC-003 §4.1); never summed with others
  timezone            text NOT NULL DEFAULT 'Europe/Zurich',  -- reporting timezone shown to the client
  languages           text[] NOT NULL DEFAULT '{}',
  starts_on           date,
  ends_on             date,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.campaign (company_id);

-- Client-configured push target (RFC-002 §15).
CREATE TABLE app.webhook (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES app.company(id),
  name                    text NOT NULL,
  campaign_ids            uuid[],                             -- NULL = all campaigns of the company
  url                     text NOT NULL CHECK (url ~* '^https://'),
  secret                  text NOT NULL,                      -- HMAC-SHA256 key, minted by us, shown once (§15.5)
  schedule_cron           text NOT NULL,                      -- '0 8 * * 1'
  timezone                text NOT NULL DEFAULT 'Europe/Zurich',
  report_window           text NOT NULL DEFAULT 'previous_week'
                            CHECK (report_window IN ('previous_day', 'previous_week', 'previous_month')),
  include_check_sources   boolean NOT NULL DEFAULT true,      -- non-primary sources as labelled series
  include_creatives       boolean NOT NULL DEFAULT true,      -- per-campaign_tag breakdown
  payload_version         int NOT NULL DEFAULT 1,
  enabled                 boolean NOT NULL DEFAULT true,
  next_run_at             timestamptz NOT NULL,
  created_by              uuid,                               -- FK to app.user added in phase 2
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.webhook (next_run_at) WHERE enabled;

-- One row per (webhook, period) = the idempotency record; its id is the X-Delivery-Id header.
CREATE TABLE app.webhook_delivery (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id       uuid NOT NULL REFERENCES app.webhook(id) ON DELETE CASCADE,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  trigger          text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         int  NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,                               -- backoff: 1m, 5m, 30m, 2h, 12h
  last_attempt_at  timestamptz,
  response_code    int,
  response_excerpt text,                                      -- first 1 KB of the client's response
  payload          jsonb NOT NULL,                            -- exact body sent, for audit + resend
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, period_start, period_end)
);
CREATE INDEX ON app.webhook_delivery (status, next_attempt_at) WHERE status = 'pending';
```

---

## 5. Schema `analytics` — the rollups and their catalog

### 5.1 Metric catalog (the contract)

```sql
CREATE SCHEMA analytics;

CREATE TABLE analytics.metric (
  id             text PRIMARY KEY,                            -- column name in the rollup table
  table_name     text NOT NULL,                               -- 'advanced_analytics' | 'page_views' | 'cta_clicks'
  unit           text NOT NULL CHECK (unit IN ('count', 'seconds', 'milliseconds')),
  aggregation    text NOT NULL CHECK (aggregation IN ('sum', 'weighted_avg', 'none')),
  weight_metric  text REFERENCES analytics.metric(id),        -- for weighted_avg
  description    text NOT NULL
);

INSERT INTO analytics.metric VALUES
  ('impressions',                 'advanced_analytics', 'count',        'sum',          NULL,           'Ad impressions'),
  ('in_view',                     'advanced_analytics', 'count',        'sum',          NULL,           'Viewable impressions; standard is source-specific (see source_metric)'),
  ('game_started',                'advanced_analytics', 'count',        'sum',          NULL,           'Users who started interacting / engagement'),
  ('game_finished',               'advanced_analytics', 'count',        'sum',          NULL,           'Users who completed the creative'),
  ('interactions',                'advanced_analytics', 'count',        'sum',          NULL,           'Touch/click interactions'),
  ('hovered',                     'advanced_analytics', 'count',        'sum',          NULL,           'Hover interactions'),
  ('in_view_time',                'advanced_analytics', 'seconds',      'sum',          NULL,           'Accumulated in-view seconds (own instrumentation)'),
  ('dwell_time',                  'advanced_analytics', 'seconds',      'sum',          NULL,           'Accumulated dwell seconds (own instrumentation)'),
  ('interaction_time',            'advanced_analytics', 'seconds',      'sum',          NULL,           'Accumulated interaction seconds (own instrumentation)'),
  ('dwell_avg_ms',                'advanced_analytics', 'milliseconds', 'weighted_avg', 'game_started', 'Platform-reported average dwell per engaged user'),
  ('unique_impressions_reported', 'advanced_analytics', 'count',        'none',         NULL,           'Platform-reported unique users with an impression, per day; never summed'),
  ('unique_clicks_reported',      'advanced_analytics', 'count',        'none',         NULL,           'Platform-reported unique users with a click, per day; never summed'),
  ('view_counter',                'page_views',         'count',        'sum',          NULL,           'Page views'),
  ('cta_counter',                 'cta_clicks',         'count',        'sum',          NULL,           'CTA clicks');

-- Which source measures which metric, and under which definition. Drives `metrics_available` in the payload.
CREATE TABLE external.source_metric (
  source_id   text NOT NULL REFERENCES external.source(id),
  metric_id   text NOT NULL REFERENCES analytics.metric(id),
  definition  text,                                            -- 'viewable = 50% in view for 1.5 s'
  PRIMARY KEY (source_id, metric_id)
);

INSERT INTO external.source_metric VALUES
  ('nexd', 'impressions',                 'performance[].impressions'),
  ('nexd', 'in_view',                     'performance[].viewable.value — 50% in view for 1.5 s'),
  ('nexd', 'game_started',                'performance[].engagement.value'),
  ('nexd', 'interactions',                'event "Unique [Touch]"'),
  ('nexd', 'hovered',                     'event "Unique [Hover]"'),
  ('nexd', 'dwell_avg_ms',                'performance[].dwell (average per engaged user)'),
  ('nexd', 'unique_impressions_reported', 'chart series unique-impressions'),
  ('nexd', 'view_counter',                'events "Page seen [...]" via event_map'),
  ('nexd', 'cta_counter',                 'events "CTR [...]" via event_map'),
  ('zeus', 'impressions',                 '/reports/creatives rows[].impressions'),
  ('zeus', 'in_view',                     'rows[].visible_impressions — viewability standard: ask Zeus'),
  ('zeus', 'game_started',                '/reports/tracker fires on the engagement pixel'),
  ('zeus', 'game_finished',               '/reports/tracker fires on the finish pixel'),
  ('zeus', 'unique_impressions_reported', 'rows[].unique_impressions'),
  ('zeus', 'unique_clicks_reported',      'rows[].unique_clicks'),
  ('zeus', 'cta_counter',                 'rows[].clicks → the link''s clickthrough CTA');
-- 'brame' rows are seeded in phase 2 together with the ingestion service.
```

### 5.2 Rollup tables

```sql
CREATE TABLE analytics.advanced_analytics (
  campaign_id                  uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  source                       text NOT NULL REFERENCES external.source(id) DEFAULT 'brame',
  language                     text NOT NULL DEFAULT '',      -- '' = not split
  campaign_tag                 text NOT NULL DEFAULT '',      -- creative-level dimension; '' = untagged
  events_date                  date NOT NULL,                 -- the source's day (external.source.day_timezone)
  impressions                  bigint,
  in_view                      bigint,
  game_started                 bigint,
  game_finished                bigint,
  interactions                 bigint,
  hovered                      bigint,
  in_view_time                 bigint,                        -- seconds, own instrumentation only
  dwell_time                   bigint,                        -- seconds, own instrumentation only
  interaction_time             bigint,                        -- seconds, own instrumentation only
  dwell_avg_ms                 numeric(12,2),                 -- platform average, weighted by game_started at read
  unique_impressions_reported  bigint,                        -- per-day scalar, never SUM()ed
  unique_clicks_reported       bigint,                        -- per-day scalar, never SUM()ed
  data_source                  text NOT NULL DEFAULT 'live' CHECK (data_source IN ('live', 'sync', 'legacy_aurora')),
  sync_run_id                  uuid,                          -- FK added after external.sync_run exists (§6)
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, source, language, campaign_tag, events_date)
);
CREATE INDEX ON analytics.advanced_analytics (campaign_id, events_date);

-- Definitions with readable names — replaces the legacy generic-campaign cta_info trick.
CREATE TABLE analytics.page (
  campaign_id  uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  page_id      text NOT NULL,                                 -- 'main', 'result'
  name         text NOT NULL,
  sort_order   int,
  PRIMARY KEY (campaign_id, page_id)
);

CREATE TABLE analytics.cta (
  campaign_id        uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  cta_id             text NOT NULL,                           -- 'clickthrough', 'cta_shop'
  name               text NOT NULL,
  url                text,
  is_internal_event  boolean NOT NULL DEFAULT false,          -- true = "event", shown separately from CTAs
  sort_order         int,
  PRIMARY KEY (campaign_id, cta_id)
);

CREATE TABLE analytics.page_views (
  campaign_id   uuid NOT NULL,
  source        text NOT NULL REFERENCES external.source(id) DEFAULT 'brame',
  language      text NOT NULL DEFAULT '',
  campaign_tag  text NOT NULL DEFAULT '',
  page_id       text NOT NULL,
  events_date   date NOT NULL,
  view_counter  bigint NOT NULL,
  data_source   text NOT NULL DEFAULT 'live' CHECK (data_source IN ('live', 'sync', 'legacy_aurora')),
  sync_run_id   uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, source, language, campaign_tag, page_id, events_date),
  FOREIGN KEY (campaign_id, page_id) REFERENCES analytics.page (campaign_id, page_id) ON DELETE CASCADE
);

CREATE TABLE analytics.cta_clicks (
  campaign_id   uuid NOT NULL,
  source        text NOT NULL REFERENCES external.source(id) DEFAULT 'brame',
  language      text NOT NULL DEFAULT '',
  campaign_tag  text NOT NULL DEFAULT '',
  cta_id        text NOT NULL,
  events_date   date NOT NULL,
  cta_counter   bigint NOT NULL,
  data_source   text NOT NULL DEFAULT 'live' CHECK (data_source IN ('live', 'sync', 'legacy_aurora')),
  sync_run_id   uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, source, language, campaign_tag, cta_id, events_date),
  FOREIGN KEY (campaign_id, cta_id) REFERENCES analytics.cta (campaign_id, cta_id) ON DELETE CASCADE
);
```

Phase-2 ingestion must upsert the `analytics.page` / `analytics.cta` definition row (`ON CONFLICT DO NOTHING`) before its counter upsert, so the FK holds for ids first seen from a creative.

---

## 6. Schema `external` — links, mappings, sync bookkeeping

```sql
-- One internal campaign ⟷ one external identity (per source, per language).
CREATE TABLE external.campaign_link (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  source_id      text NOT NULL REFERENCES external.source(id),
  credential_id  uuid NOT NULL REFERENCES external.credential(id),
  language       text NOT NULL DEFAULT '',                    -- stamped on every synced row
  config         jsonb NOT NULL DEFAULT '{}',                 -- connector-specific; validated against connector.describe()
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, source_id, language)
);

-- The external IDs themselves, one row per referenced entity (RFC-003 §3.1).
CREATE TABLE external.link_entity (
  link_id       uuid NOT NULL REFERENCES external.campaign_link(id) ON DELETE CASCADE,
  source_id     text NOT NULL REFERENCES external.source(id), -- denormalised so the unique index below works
  level         text NOT NULL CHECK (level IN ('campaign', 'creative', 'pixel', 'line_item', 'placement', 'order')),
  external_id   text NOT NULL,                                -- NEXD live_id · Zeus campaign_id / creative_id / pixel code
  role          text,                                         -- pixel: 'engagement' | 'finish'
  label         text,                                         -- human name for the per-creative breakdown
  campaign_tag  text NOT NULL DEFAULT '',                     -- what the writer stamps on rows from this entity; a Zeus pixel carries its creative's tag
  PRIMARY KEY (link_id, level, external_id)
);
CREATE UNIQUE INDEX ON external.link_entity (source_id, level, external_id);   -- an external entity belongs to one campaign

-- Named platform events → targets (NEXD). Zeus has no named events; its pixels are entities with roles.
CREATE TABLE external.event_map (
  link_id      uuid NOT NULL REFERENCES external.campaign_link(id) ON DELETE CASCADE,
  event_name   text NOT NULL,                                 -- 'Page seen [Main media]', 'CTR [global]'
  target_kind  text NOT NULL CHECK (target_kind IN ('metric', 'page_view', 'cta_click', 'ignore')),
  target_id    text,                                          -- metric id | page_id | cta_id (validated by trigger)
  PRIMARY KEY (link_id, event_name)
);

-- Events seen in a payload with no event_map row → the "map this" queue.
CREATE TABLE external.unmapped_event (
  link_id     uuid NOT NULL REFERENCES external.campaign_link(id) ON DELETE CASCADE,
  event_name  text NOT NULL,
  first_seen  date NOT NULL,
  last_seen   date NOT NULL,
  total_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, event_name)
);

CREATE TABLE external.sync_state (
  link_id                uuid PRIMARY KEY REFERENCES external.campaign_link(id) ON DELETE CASCADE,
  cursor                 jsonb NOT NULL DEFAULT '{}',         -- opaque, connector-owned; committed after the analytics write
  data_complete_through  date,                                -- last fully written day → payload `data_complete_through`
  last_synced_at         timestamptz,
  last_deep_sync_at      timestamptz
);

CREATE TABLE external.sync_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id       uuid NOT NULL REFERENCES external.campaign_link(id) ON DELETE CASCADE,
  trigger       text NOT NULL CHECK (trigger IN ('cron', 'manual', 'backfill')),
  triggered_by  uuid,                                         -- FK to app.user added in phase 2
  window_from   date NOT NULL,
  window_to     date NOT NULL,
  dry_run       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  days_written  int,
  rows_written  int,
  warnings      jsonb NOT NULL DEFAULT '[]',
  error         text
);
CREATE INDEX ON external.sync_run (link_id, started_at DESC);

ALTER TABLE analytics.advanced_analytics ADD FOREIGN KEY (sync_run_id) REFERENCES external.sync_run(id) ON DELETE SET NULL;
ALTER TABLE analytics.page_views         ADD FOREIGN KEY (sync_run_id) REFERENCES external.sync_run(id) ON DELETE SET NULL;
ALTER TABLE analytics.cta_clicks         ADD FOREIGN KEY (sync_run_id) REFERENCES external.sync_run(id) ON DELETE SET NULL;

-- Raw responses for replay/debug; purged at 30 days by pg_cron. Authorization headers never stored.
CREATE TABLE external.raw_payload (
  id           bigserial PRIMARY KEY,
  sync_run_id  uuid NOT NULL REFERENCES external.sync_run(id) ON DELETE CASCADE,
  request      jsonb NOT NULL,                                -- endpoint + params
  response     jsonb NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);
```

---

## 7. Read layer (Postgres functions, phase 1)

The webhook payload is assembled **only** through these; the phase-2 dashboard calls the same functions via `supabase.rpc()`. All take `(p_campaign_id uuid, p_from date, p_to date, p_source text DEFAULT NULL)`; `NULL` source resolves to `app.campaign.primary_source`.

| Function | Returns |
|---|---|
| `analytics.get_engagement_daily` | one row per `(events_date, language, campaign_tag)` with every metric column; `dwell_avg_ms` untouched per day |
| `analytics.get_engagement_totals` | range totals: `SUM` for sum-metrics, `SUM(dwell_avg_ms × game_started) / SUM(game_started)` for the average, `NULL` for `none`-metrics |
| `analytics.get_creative_breakdown` | totals grouped by `campaign_tag`, joined to `link_entity.label` |
| `analytics.get_page_views` | totals per `page_id` with `analytics.page.name` |
| `analytics.get_cta_clicks` | totals per `cta_id` with `analytics.cta.name`, `is_internal_event` |
| `analytics.get_source_status` | per source: `metrics_available` (from `source_metric`), `data_complete_through`, `last_synced_at`, `day_timezone` |
| `app.build_webhook_payload(p_webhook_id, p_period_start, p_period_end)` | the versioned JSON document (RFC-002 §15.4) — calls the functions above per campaign and per source |

Rules enforced inside the functions, once: no cross-source sums; `none`-aggregation metrics are never totalled over a range; `NULL` stays `NULL` (never coalesced to 0).

---

## 8. Added in phase 2 — without touching anything above

| Addition | Kind |
|---|---|
| `app.user` (mirrors `auth.users`), role claim hook, RLS policies on every `app.*`/`analytics.*` table, `app.audit_log` | new tables + policies |
| `created_by` / `triggered_by` FKs to `app.user` | `ALTER … ADD FOREIGN KEY` |
| `analytics.campaign_info` (game config for `/get-info`), `analytics.ad_impressions` (MRC viewability buckets), `analytics.utm_parameters_analytics`, `analytics.answers_collection` | new tables |
| `hll` columns (`unique_users`, `unique_viewers`, `unique_clickers`) on the rollups | `ALTER … ADD COLUMN` |
| `external.device_daily` (Zeus device split, RFC-003 §2.4) | new table |
| `'brame'` rows in `external.source_metric`; ingestion service writes `source = 'brame'`, `data_source = 'live'` | seed rows + code |
| `pg_cron` jobs: retention purge scoped to `source = 'brame' AND data_source = 'live'`, `raw_payload` 30-day purge | jobs |
| §13 backfill: `staging` schema, `app.legacy_campaign_map`, rows stamped `data_source = 'legacy_aurora'` | throwaway schema + `INSERT … SELECT` |

---

## 9. Confirmations needed before this becomes migration `0001`

1. `campaign_id` as `uuid` + FK in `analytics.*` (RFC-002 §7.1 currently says "uuid cast to text").
2. Nullable metric columns, no `DEFAULT 0`.
3. `campaign_tag` = creative-level dimension (Zeus `creative_id` / NEXD `live_id`), campaign totals computed at read.
4. NEXD's average dwell stored in `dwell_avg_ms` only; the three legacy time columns reserved for own instrumentation.
5. `day_timezone` values for `nexd` and `zeus` (RFC-003 §7 questions to both supports).
