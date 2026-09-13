# Phase 1 build plan — analytics sync + client webhook service

> Paste this whole file as the first prompt in the new, empty repository.
> Before pasting, copy `docs/RFC-002-standalone-analytics-app-supabase.md`, `docs/RFC-003-external-analytics-adapter.md` and `docs/RFC-004-phase1-database-schema.md` from the `tailor-made-games` repo into `docs/` of the new repo. RFC-004 is the schema of record; where this prompt and RFC-004 disagree, RFC-004 wins.

---

## Context

You are building **phase 1** of a standalone analytics product for playable-ad campaigns. Some of our creatives are served by third-party ad platforms that own the analytics: **NEXD** (creatives call `nexd.sendEvent`) and **Zeus** (the adserver behind our **ATK** tracking pixels, fired by `loadATK(customer, checksum, creativeId, page)`). Phase 1 pulls those numbers into our own Postgres nightly and on demand, and pushes a signed, versioned JSON report to each client's HTTPS endpoint on a per-client schedule.

**In scope (phase 1):** Postgres schema (RFC-004), NEXD connector, Zeus/ATK connector, sync engine + scheduler + on-demand trigger, Postgres read functions, webhook payload v1, webhook scheduler + delivery + retries, CLI for operators (no UI), tests, CI, deploy to one Render instance + one Supabase project.

**Out of scope (phase 2, must be additive later):** React dashboard, Supabase Auth users, RLS policies, our own ingestion endpoints (`/play`, `/report_impression`, …), rows with `source = 'brame'`, HLL unique counting, CSV export, retention purge, historical backfill, device split. Do **not** scaffold any of these. Do not create tables, columns or keys beyond RFC-004; anything phase 2 needs is added then.

## Non-negotiable rules

1. **Schema is RFC-004, verbatim.** Natural primary keys with `source` inside them, `campaign_id uuid` with FKs, metric columns **nullable with no `DEFAULT 0`** (`NULL` = not measured by that source), key text columns `NOT NULL DEFAULT ''`. If a step seems to need a schema change, stop and ask; do not improvise.
2. **Never sum across sources.** Each campaign has one `primary_source`; the payload's headline is that source only, other sources are separate labelled blocks. Never `SUM()` `unique_*_reported` across days. `dwell_avg_ms` is averaged weighted by `game_started`, never summed. These rules live in the SQL read functions, once.
3. **External rows are replaced, never incremented.** A sync writes a whole `(link, day)` slice in one transaction: `DELETE` that day's rows for that `source`, then `INSERT`. Under `pg_advisory_xact_lock(hashtext(link_id))`. The cursor in `sync_state` is committed only after the analytics write commits.
4. **Secrets only in environment variables.** `external.credential.secret_env_var` is a pointer. Never log or persist `Authorization` headers. Never commit `.env`.
5. **Unsupported metrics are omitted, not zero.** A connector's mapper returns only the metrics its platform measures. `external.source_metric` is the source of truth for `metrics_available`.
6. **All reads go through Postgres functions** (RFC-004 §7). The service never assembles analytics in TypeScript; it calls `app.build_webhook_payload(...)` and sends the result.
7. **Each step below ends with passing tests and a commit.** Do not start the next step with a red suite. Do not skip tests to move faster.
8. **Timezones are explicit.** `events_date` is the source's day in `external.source.day_timezone`. Webhook schedules use `cron-parser` with the webhook's IANA timezone. Never use the server's local time.

## Stack (fixed)

- Node 20+, TypeScript strict, ESM. Package manager: `npm`.
- HTTP: **Fastify**. DB: **`pg`** (`Pool`, `max: 10`), SQL migrations via **Supabase CLI** (`supabase/migrations/*.sql`), local stack via `supabase start` (Docker).
- Validation: **zod** (env config, request bodies, connector configs, external API payloads). Logging: **pino**. Scheduling: **node-cron** + **cron-parser**. HTTP client: built-in `fetch` (undici) wrapped in our `HttpClient`.
- Tests: **Vitest**. Integration tests run against the local Supabase Postgres (`DATABASE_URL` from `supabase status`). SQL function tests in Vitest via fixture rows (pgTAP is optional, add if cheap).
- Lint/format: ESLint (typescript-eslint) + Prettier. CI: GitHub Actions.
- Deploy targets (later steps): Supabase project in `eu-central-2` (Zürich), Render web service in Frankfurt.

## Repository layout to create

```
.
├── docs/                      RFC-002, RFC-003, RFC-004, WEBHOOK-PAYLOAD-v1.md, RUNBOOK.md
├── supabase/
│   ├── config.toml
│   ├── migrations/            0001_foundation.sql (RFC-004 §3–§6 + seeds), 0002_read_functions.sql (§7), …
│   └── seed.sql               local dev fixtures only (one company, one campaign, one link per source)
├── src/
│   ├── index.ts               Fastify bootstrap, /healthz, /readyz, route registration, scheduler start
│   ├── config.ts              zod-validated env
│   ├── db.ts                  Pool, query(), withTransaction(), advisory-lock helpers
│   ├── log.ts                 pino
│   ├── http/HttpClient.ts     retries, backoff, per-credential rate limit, header redaction
│   ├── routes/
│   │   ├── sync.ts            POST /sync/links/:linkId/run
│   │   └── webhooks.ts        POST /webhooks/:id/send-now
│   ├── sync/
│   │   ├── types.ts           CanonicalDailyRow, SourceConnector, Mapper, SyncContext, SyncResult
│   │   ├── registry.ts        connector lookup by source id
│   │   ├── engine.ts          runSync(linkId, window, trigger)
│   │   ├── writer.ts          day-replace transaction
│   │   ├── scheduler.ts       nightly 04:00 Europe/Zurich behind leader lock
│   │   └── connectors/
│   │       ├── nexd/          connector.ts, mapper.ts, schema.ts (zod), fixtures/
│   │       └── zeus/          connector.ts, mapper.ts, schema.ts (zod), fixtures/
│   ├── webhooks/
│   │   ├── scheduler.ts       minutely due-check tick behind leader lock
│   │   ├── deliver.ts         payload fetch, HMAC, POST, retry/backoff, delivery log
│   │   └── ssrf.ts            resolve host, refuse private/loopback/link-local
│   └── cli/
│       ├── sync.ts            npm run sync -- --link <id> --from --to [--dry-run] | --source zeus --list-pixels
│       └── admin.ts           npm run admin -- company|campaign|link|entity|event-map|webhook <create|list>
├── tests/                     unit/, integration/, fixtures/
├── .github/workflows/pr.yml
├── .env.example
└── README.md
```

## External API facts you will need

### NEXD (`https://api.nexd.com`, `Authorization: Bearer <NEXD_API_KEY>`)
- `POST /analytics/creatives/{live_id}` body `{ base: "impressions", startDate, endDate, traffic: "all", device: "all", incvtr: true }`, dates as **UNIX seconds**. Response `result.analytics`:
  - `performance[]` one object per day: `date` (`YYYY-MM-DD`, undocumented; spec documents `dt` timestamp — accept either), `impressions`, `loaded`, `viewable.value`, `engagement.value`, `ctr.value`, `dwell` (**average ms per engaged user**).
  - `eventsList{ "YYYY-MM-DD": [ { action: { original }, count, u_count } ] }` per-day events — **undocumented**. `events[]` is the documented range total.
  - `summary.totals` — range totals used to verify the written days (`impressions`, `viewable`, `engagement.clicks`).
- Chunk requests to **≤ 21 days** (daily buckets only up to 21 days). Assert returned days are consecutive.
- Fallback if `eventsList` is missing: one request per day, read `events[]`. A contract test must fail if the fixture shape changes.
- Mapping (per day, per live_id): `impressions←performance.impressions`, `in_view←viewable.value`, `game_started←engagement.value`, `interactions←event "Unique [Touch]"`, `hovered←event "Unique [Hover]"`, `dwell_avg_ms←dwell`, `view_counter←"Page seen [...]"` via `event_map`, `cta_counter←"CTR [...]"` via `event_map`. `game_finished` not available → omit.
- Several `live_id`s belong to one campaign; each becomes its own `campaign_tag` row (tag = `link_entity.campaign_tag`, default = the live_id). Campaign totals are computed at read time.

### Zeus (`https://t.zeus.ad`, `Authorization: Bearer <ZEUS_API_TOKEN>`; OpenAPI at `/api/doc.json`)
- Four read-only GETs, all daily aggregates, **latest day is always yesterday**, `to` is clamped: `GET /api/v1/reports/{campaigns|creatives|devices|tracker}?from=YYYY-MM-DD&to=YYYY-MM-DD[&internal_id=|&external_id=]`. Response `{ customer, from, to, rows[] }`.
- `creatives` rows: `date, campaign_id, external_id, creative_id, creative_name, impressions, unique_impressions, clicks, unique_clicks, ctr, visible_impressions, visibility`.
- `tracker` rows: `date, pixel_id, external_id, code, name, fires`. Fetch **unfiltered** once per window and match rows to `link_entity` (level `pixel`) by `code`, then `external_id`, then `name` — which field carries our ATK checksum/page name is **unconfirmed**; do not hardcode one.
- Mapping: `impressions←creatives.impressions`, `in_view←visible_impressions`, `unique_impressions_reported←unique_impressions`, `unique_clicks_reported←unique_clicks`, `cta_counter←clicks` (to the link's clickthrough `cta_id` from config), `game_started←tracker.fires` on pixels with `role='engagement'`, `game_finished←fires` on `role='finish'`. Never store `ctr` / `visibility`.
- Chunk to **≤ 31 days**. Verify per day: `clicks ≤ impressions`, `visible_impressions ≤ impressions`, `unique_impressions ≤ impressions`, each requested day present at most once per entity. A violated invariant fails the run.
- `campaign_tag` for a creative row = `link_entity.campaign_tag` of that creative; a pixel's fires are stamped with the pixel entity's `campaign_tag` (an operator sets it to the creative's tag).

## Webhook payload contract v1 (write it up in `docs/WEBHOOK-PAYLOAD-v1.md` in step 10)

Headers: `Content-Type: application/json`, `X-Delivery-Id: <webhook_delivery.id>`, `X-Timestamp: <unix seconds>`, `X-Signature: sha256=<hex HMAC-SHA256(secret, deliveryId + "." + timestamp + "." + rawBody)>`, `X-Payload-Version: 1`. The delivery id is inside the signed input so it cannot be altered without breaking the signature. Serialise the body once into a buffer and sign exactly those bytes. For rotation without downtime, sign with every active secret and send the signatures comma-separated in `X-Signature`; that needs an additive second-secret column on `app.webhook`, so confirm with the RFC-004 owner before step 11 (code review, 2026-09). Only a 2xx counts as delivered. Timeout 10 s. Retries 1 m, 5 m, 30 m, 2 h, 12 h.

```json
{
  "version": 1,
  "delivery_id": "uuid",
  "generated_at": "2026-09-14T06:00:03Z",
  "period": { "start": "2026-09-07", "end": "2026-09-13", "timezone": "Europe/Zurich", "window": "previous_week" },
  "company": { "id": "uuid", "name": "…" },
  "campaigns": [
    {
      "id": "uuid", "name": "AT2608 Tchibo Caffè Crema", "primary_source": "zeus",
      "sources": [
        {
          "source": "zeus", "display_name": "ATK (Zeus)", "role": "primary",
          "day_timezone": "UTC", "data_complete_through": "2026-09-13", "last_synced_at": "2026-09-14T02:05:11Z",
          "metrics_available": ["impressions", "in_view", "game_started", "game_finished", "cta_counter", "unique_impressions_reported", "unique_clicks_reported"],
          "totals": { "impressions": 123456, "in_view": 98765, "game_started": 4321, "game_finished": 2100, "cta_counter": 987, "unique_impressions_reported": null, "unique_clicks_reported": null },
          "daily": [ { "date": "2026-09-07", "language": "de", "impressions": 17000, "in_view": 14000, "game_started": 600, "game_finished": 290, "cta_counter": 140, "unique_impressions_reported": 15800, "unique_clicks_reported": 130 } ],
          "creatives": [ { "campaign_tag": "mpu_v1", "label": "ENG Swipe MPU V1", "totals": { "impressions": 60000, "game_started": 2000 } } ],
          "ctas": [ { "cta_id": "clickthrough", "name": "Click-out", "is_internal_event": false, "count": 987 } ],
          "pages": []
        },
        { "source": "nexd", "role": "check", "…": "same shape, only metrics NEXD measures" }
      ]
    }
  ]
}
```
Rules: metrics not in `metrics_available` are absent from `daily`/`totals`; `none`-aggregation metrics are `null` in `totals`; nothing is summed across sources; field names are the `analytics.metric.id` values and are frozen — v2 may add fields, never rename.

## Operator prerequisites (humans provide; do not block on them for steps 0–4, 7, 9–13)

- `NEXD_API_KEY` — a **freshly rotated** key (the old one was committed to the legacy repo; treat it as compromised).
- `ZEUS_API_TOKEN` + answers from Zeus support: which `tracker` field carries our ATK identity, what timezone a "day" is, whether completed days are ever restated, rate limits, retention.
- From NEXD support: `analytics_timezone` semantics for `performance[].date`, rate limits, whether `eventsList` is supported.
- One pilot client: campaign name, NEXD live ids and/or Zeus campaign/creative/pixel ids with engagement/finish roles, language, webhook URL, schedule, window.

Until real credentials exist, connectors are developed against recorded fixtures; the first live call is step 14.

---

## Steps

### Step 0 — Docs in place
Copy the three RFCs into `docs/`. Read RFC-004 fully before writing any SQL. **Done when:** `docs/` contains RFC-002, RFC-003, RFC-004 and this plan.

### Step 1 — Repo scaffolding and tooling
`npm init`, TypeScript strict ESM config, ESLint + Prettier, Vitest with `unit` and `integration` projects, `.env.example` (`DATABASE_URL`, `NEXD_API_KEY`, `ZEUS_API_TOKEN`, `SERVICE_ADMIN_TOKEN`, `PORT`, `LOG_LEVEL`, `TZ=UTC`), `.gitignore` (`.env`, `node_modules`, `supabase/.temp`), README with the one-paragraph purpose and the local-dev commands. Scripts: `dev`, `build`, `typecheck`, `lint`, `test`, `test:integration`, `sync`, `admin`, `db:reset`.
**Done when:** `npm run typecheck && npm run lint && npm test` pass on an empty `src/`.

### Step 2 — Migration 0001: the foundation schema
`supabase init`, `supabase start`. Write `supabase/migrations/0001_foundation.sql` as RFC-004 §3, §4, §5, §6 in that creation order, including the `external.source`, `analytics.metric` and `external.source_metric` seed rows. Add a trigger that validates `external.event_map.target_id` against `analytics.metric` / `analytics.page` / `analytics.cta` per `target_kind`. Add `supabase/seed.sql` with one dev company, one campaign (`primary_source = 'zeus'`), one credential per platform, one link per platform with two entities each.
Integration test: `supabase db reset` succeeds; every table from RFC-004 exists with the expected primary key; inserting a duplicate natural key fails; inserting `advanced_analytics` with `source = 'foo'` fails; `NULL` metric insert succeeds.
**Done when:** the tests above pass and `supabase db diff` is empty.

### Step 3 — Service skeleton
`config.ts` (zod env), `db.ts` (Pool `max: 10`, `query`, `withTransaction`, `tryAdvisoryLock(key)` / `xactLock(key)`), `log.ts`, Fastify app with `GET /healthz` (always 200) and `GET /readyz` (200 only if `SELECT 1` succeeds within 2 s). Admin auth plugin: routes under `/sync` and `/webhooks` require `Authorization: Bearer <SERVICE_ADMIN_TOKEN>` (phase 1 stand-in for Supabase user tokens; keep it in one plugin so phase 2 swaps it).
**Done when:** unit tests for config validation and auth plugin pass; integration test hits `/readyz` against local Postgres.

### Step 4 — Connector framework
`sync/types.ts`: `CanonicalDailyRow { date, language, campaignTag, metrics: Partial<Record<MetricId, number>>, pageViews: {pageId,count}[], ctaClicks: {ctaId,count}[], unmapped: Record<string,number> }`; `SourceConnector { id, capabilities, identity, describe(), checkConnection(ctx), fetchWindow(ctx): Promise<{ rows: CanonicalDailyRow[], raw: RawCapture[], warnings: string[] }> }`; `Mapper` as a pure function. `HttpClient` with retries (429/5xx/network, exponential backoff with jitter, max 5), per-credential concurrency 1, response-size cap, and a `redact()` that strips `Authorization` from anything logged or stored. `registry.ts`.
**Done when:** unit tests cover backoff schedule, redaction, and that an unknown source id throws.

### Step 5 — NEXD connector
`connectors/nexd/schema.ts` zod schema of the parts we read (tolerant of extra fields; `performance[].date` or `dt`). `connector.ts`: chunk to ≤ 21 days, one request per `link_entity` of level `creative`, capture raw, detect `eventsList` and fall back to per-day `events[]`. `mapper.ts`: pure, uses the link's `event_map`; unmapped event names go to `unmapped`. Fixtures: a recorded response (use the legacy repo's shape; replace with a real recording in step 14). Verify step: sum of written `impressions` / `in_view` / `game_started` over the window equals `summary.totals`, else the run fails.
**Done when:** mapper fixture tests reproduce the known sample totals (impressions 76 200, in_view 64 847, game_started 5 055, interactions 4 620, hovered 1 893 for the legacy sample); contract test fails when `eventsList` is removed from the fixture **and** the fallback path is not exercised.

### Step 6 — Zeus connector
`connectors/zeus/schema.ts` for the four reports. `connector.ts`: ≤ 31-day chunks; `creatives` filtered by the link's campaign `external_id` (fallback `internal_id`), `tracker` unfiltered and matched locally by `code` → `external_id` → `name`; `campaigns` only when the link has no creative entity. `mapper.ts` per the mapping above; unsupported metrics omitted. Consistency assertions per §"Zeus" above. `--list-pixels` output (table of `pixel_id, external_id, code, name, fires-last-7-days`).
**Done when:** fixture tests cover: engagement + finish pixels attributed to the right `campaign_tag`; a violated invariant fails the run; an unmatched pixel lands in `unmapped`.

### Step 7 — Sync engine and writer
`engine.ts` `runSync(linkId, window, trigger, { dryRun, triggeredBy })`: insert `sync_run` (running) → resolve link/entities/event_map/credential → `connector.fetchWindow` → group rows by day → for each day, in one transaction under `pg_advisory_xact_lock(hashtext(link_id))`: `DELETE` the day's rows for `(campaign_id, source)` in all three rollup tables, `INSERT` the new rows with `data_source = 'sync'` and `sync_run_id`, upsert `unmapped_event` → after all days: update `sync_state` (`cursor`, `data_complete_through`, `last_synced_at`) → `sync_run` succeeded with counts, or failed with the error and **no partial day written**. Store `raw_payload` per request. `dryRun`: compute the diff (rows to delete / insert, per-metric deltas) and return it without writing. Cooldown: a manual run within `min_manual_interval` of the last one for the link returns a `TooSoon` error.
**Done when:** integration tests prove: re-running the same window is idempotent; a restated day fully replaces the previous rows (a dropped CTA disappears); a failing entity fetch aborts the day and leaves prior rows intact; `sync_state` is not advanced on failure.

### Step 8 — Operator CLI
`npm run sync -- --link <id> --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run] [--trigger backfill]`, `npm run sync -- --all` (what the nightly job does), `npm run sync -- --source zeus --list-pixels`, `npm run sync -- --check-connection <credential>`. `npm run admin -- …` subcommands to create/list companies, campaigns, credentials, links, entities, event maps, pages, CTAs and webhooks, each printing the resulting row. All CLI commands reuse the same code as the service (no duplicated SQL).
**Done when:** a scripted end-to-end run on the local stack creates a company → campaign → link → entities → event map, runs a dry-run sync from fixtures via a mock HTTP server, then a real write, and the rollup tables contain the expected rows.

### Step 9 — Sync scheduler and trigger route
`sync/scheduler.ts`: `node-cron` at `04:00 Europe/Zurich`; on tick `pg_try_advisory_lock(<constant>)`, exit if not acquired; run every enabled link sequentially per credential with the source's `lookback_days`, and `deep_lookback_days` on Sundays; release the lock. Sync work uses at most 3 of the 10 pool connections (a small semaphore). `POST /sync/links/:linkId/run { from?, to?, dryRun? }` → `202 { syncRunId }`; `GET /sync/runs/:id` for status. Sync failures never affect `/readyz`.
**Done when:** tests prove two concurrent scheduler ticks run one job; the route enforces admin auth and the cooldown.

### Step 10 — Migration 0002: read functions + payload builder
Implement RFC-004 §7 functions in SQL: `analytics.get_engagement_daily`, `get_engagement_totals`, `get_creative_breakdown`, `get_page_views`, `get_cta_clicks`, `get_source_status`, and `app.build_webhook_payload(webhook_id, period_start, period_end) RETURNS jsonb` producing exactly the contract above (period from the webhook's `report_window` and `timezone`; campaigns from `campaign_ids` or all of the company's; primary block first, check blocks only when `include_check_sources`; `creatives` only when `include_creatives`). Write `docs/WEBHOOK-PAYLOAD-v1.md` with the JSON example, header spec, signature recipe (with a worked example a client can verify), retry semantics, and the "never summed across sources / uniques per day only" notes.
**Done when:** integration tests with fixture rows prove: totals equal the sum of dailies for sum-metrics; `unique_*_reported` totals are `null`; `dwell_avg_ms` total is the `game_started`-weighted average; a source with no rows appears with empty `daily` and `null` totals; a metric absent from `source_metric` is absent from the JSON; the JSON validates against a zod schema of the contract.

### Step 11 — Webhook scheduler and delivery
`webhooks/scheduler.ts`: minutely `node-cron` tick behind its own advisory lock; `SELECT … FROM app.webhook WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED`; for each: compute the period, insert `webhook_delivery` (pending, `trigger='schedule'`, `payload` = `app.build_webhook_payload(...)`), recompute `next_run_at` with `cron-parser` in the webhook's timezone. Then process due deliveries (`status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())`): `deliver.ts` builds headers, signs, POSTs with 10 s timeout, records `response_code`/`response_excerpt`, marks `delivered` on 2xx, otherwise increments `attempts` and sets `next_attempt_at` from the backoff table, `failed` after the 5th attempt. `ssrf.ts` resolves the URL host and refuses private, loopback, link-local and metadata ranges before every attempt. `POST /webhooks/:id/send-now { period_start?, period_end? }` inserts a `trigger='manual'` delivery (or re-queues an existing failed one for the same period) and returns `202 { deliveryId }`.
**Done when:** integration tests against a stub receiver prove: a 200 marks delivered with a valid signature the stub verifies; a 500 schedules the retry at +1 m; the 5th failure marks `failed`; `X-Delivery-Id` is stable across retries; a webhook pointing at `http://` or `https://127.0.0.1` is refused; DST: a `0 8 * * 1` Europe/Zurich webhook fires at 08:00 local both sides of the March and October changes.

### Step 12 — CI
`.github/workflows/pr.yml`: `npm ci`, `typecheck`, `lint`, `npm audit --audit-level=high`, `supabase start` + `supabase db reset`, `npm test` (unit + integration), `npm run build`. Dependabot config. Branch protection notes in README (`main` = dev, `prod` = production, PR-only).
**Done when:** the workflow is green on a PR.

### Step 13 — Runbook and README
`docs/RUNBOOK.md`: local setup, adding a client (admin CLI sequence), rotating a credential, running a backfill, reading `sync_run` / `webhook_delivery`, re-sending a report, what to do when a run fails verification, what the client sees (headers, retries). README: architecture diagram (this service + Supabase), environment variables, scripts.
**Done when:** a new developer can follow the runbook from clone to a delivered test webhook on the local stack.

### Step 14 — First live calls (needs the operator prerequisites)
With real keys in `.env` (never committed): `--check-connection` for both credentials; `--source zeus --list-pixels` and record which field holds our ATK checksum/page names; record one real NEXD response and one real Zeus window into `fixtures/` (redacted); confirm `performance[].date` vs `dt`; set `external.source.day_timezone` from the support answers. Dry-run the pilot campaign for the last 35 days, review the diff, then write. Reconcile one campaign-week manually against the NEXD UI and the Zeus UI and record the result in `docs/RUNBOOK.md`.
**Done when:** the pilot campaign has synced rows for both sources and the manual reconciliation matches (or the discrepancies are explained in the runbook).

### Step 15 — Deploy dev
Create the Supabase project (Pro, `eu-central-2`), `supabase link`, `supabase db push` over the **direct** connection; create the Render web service (Starter, Frankfurt, health check `/readyz`, env vars set in the dashboard, auto-deploy from `main`). Add `deploy.yml` (migrations via Supabase CLI on push to `main`, then smoke: `/healthz`, `/readyz`). Point the pilot webhook at a test receiver (the client's staging endpoint or a request-bin) and let one scheduled delivery run end to end.
**Done when:** one scheduled delivery is `delivered` in `app.webhook_delivery` on the dev environment and the receiver verified the signature.

### Step 16 — Pilot sign-off and prod
Agree the payload with the pilot client against `docs/WEBHOOK-PAYLOAD-v1.md`. Create the `prod` branch, prod Supabase project and prod Render service, protection rules, `deploy.yml` prod job with manual approval. Promote. Configure the real client webhook.
**Done when:** the client receives the first scheduled production report.

---

## How to work

- Work one step at a time, in order. Start each step by restating its "Done when" and end it by showing the passing test output and a commit on a feature branch.
- Ask before: changing anything in RFC-004, adding a dependency not listed in the stack, or building anything from the out-of-scope list.
- Keep SQL in `.sql` migration files or in `src/**/sql/*.sql` files loaded at startup; no SQL string concatenation with user input, parameters only.
- Prefer small, boring code. No abstractions for a third connector until one exists.
