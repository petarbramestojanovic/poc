# CLAUDE.md — analytics-be

Phase 1 of the standalone analytics product: nightly and on-demand sync of **NEXD** and **Zeus (ATK)** analytics into Postgres, then signed, scheduled report webhooks to clients. One Node service (Render) plus one Supabase Postgres project. No UI in phase 1.

Design of record, in order of precedence: `docs/RFC-004-phase1-database-schema.md` (schema), `docs/RFC-003-external-analytics-adapter.md` (connectors, sync), `docs/RFC-002-standalone-analytics-app-supabase.md` (platform), `docs/PHASE1-PLAN-PROMPT.md` (steps and done-when criteria). When this file and an RFC disagree, the RFC wins; say so instead of picking silently.

**The repo is the application only.** `docs/` (those four, plus `RUNBOOK.md` and the client contract `WEBHOOK-PAYLOAD-v2.md`, which supersedes `-v1.md`) and `dev/` (the throwaway console and webhook receiver) are git-ignored: they exist on the maintainer's machine, so read them from disk and keep them up to date there, but never expect them in a clone or add them back to the repo.

The rules below are distilled from the September 2026 code review of steps 1–7 (69 findings). Most of them exist because a guard was declared but did not hold under the condition it was written for. Keep the guards real.

## Commands

```sh
npm run typecheck          # tsc --noEmit over src, tests, scripts
npm run lint               # type-aware ESLint + Prettier check
npm test                   # unit tests, no database
npm run test:integration   # needs `npx supabase start` and DATABASE_URL (see .env.example)
npm run build && npm run build:smoke   # compile, copy sql/, import the built modules
npx supabase migration up  # apply new migrations locally; `npm run db:reset` recreates + seeds
npm run check:migrations -- origin/main   # the CI migration guard: append-only against a base
```

A change is done when `typecheck`, `lint`, `test` and `test:integration` are all green. Run `build:smoke` whenever you add, rename or move a `.sql` file or touch the build.

CI (`.github/workflows/ci.yml`) runs all of that, plus the migration guard and `npm audit`, on every PR to `main`, with no secrets. Every merge to `main` deploys **staging** (`deploy-staging.yml`: CI, `supabase db push`, Render deploy hook, wait for `/healthz` to report the commit). Production will come from a `release` branch and is not built yet: do not add prod jobs unasked. Setup and rollback: `docs/RUNBOOK.md` §10.

## Layout

- `src/app.ts` builds the Fastify app and its auth scopes, `src/index.ts` runs the process, `src/runtime.ts` holds what the service and the CLI share; `src/cli/` is the operator CLI.
- `src/core/` is infrastructure with no business rules: config, db, log, errors, dates, secrets, sql-file, limiter, schemas, external-ref, `http/` (the outbound client), `plugins/` (token checks). Core never imports a module.
- `src/modules/<name>/` is one domain each — `companies`, `campaigns`, `salesforce`, `sync`, `webhooks`, `health` — owning its `routes.ts`, service, repo, `sql/` and errors. Dependencies point one way: `salesforce → campaigns → companies`, `campaigns → sync` (connectors decide what a link accepts), `webhooks → sync`. Never import back up that chain; a new module (email reports, a second CRM) goes beside them.
- Tests stay in `tests/unit` and `tests/integration` (the split is by directory).

## Scope and change control

- **Ask first** before: changing anything RFC-004 defines (tables, columns, keys, seeds), adding a dependency outside the fixed stack (Fastify, pg, zod, pino, node-cron, cron-parser, Vitest, ESLint, Prettier, Supabase CLI), or building phase 2 work (dashboard, Supabase Auth users, RLS, own ingestion routes, `source = 'brame'` rows, HLL, CSV export, retention purge, backfill, device split). Approved exception (2026-10-07): `POST /inbound/campaigns`, the daily Salesforce report — campaigns, not analytics.
- **Additive migrations only.** New indexes are fine and must be flagged in the PR. Never edit an applied migration; add the next numbered file.
- **Approved deviations from RFC-004** (the RFC files stay verbatim; the migration header is the record): `0004_external_refs.sql` adds `external_system` + `external_id` to `app.company` and `app.campaign` (2026-09-20), so another system can push the same record twice. They identify a row and never describe it: no CRM field belongs in the model. `0005_campaign_price.sql` adds `price` + `currency` to `app.campaign` (2026-09-22): the CPM the campaign is sold at, both or neither, `NULL` when not known (never 0). `0006_rls_and_reader_grants.sql` (2026-09-23) turns RLS on and grants a logged-in reader — phase-2 work brought forward so the local React console can read analytics through supabase-js, as RFC-002 §15 plans for the dashboard. No table, column or key changes. `0007_webhook_payload_fields.sql` (2026-09-29) adds `payload_fields jsonb` to `app.webhook` — a per-webhook field list with admin-entered formulas, `NULL` = the full v1 body — and replaces the body of `app.build_webhook_payload` so a report skips archived campaigns and campaigns whose flight does not touch the period and that have no numbers in it. `0008_webhook_rows.sql` (2026-10-10) adds `format` (`json` | `csv`) and `auth_header` + `auth_token` (the client's own key for its endpoint, both or neither) to `app.webhook`; since then the body is version 2, flat rows, and `payload_fields` holds the column list. It also replaces `app.webhook_delivery`'s `UNIQUE (webhook_id, period_start, period_end)` with a unique index on the same columns `WHERE trigger = 'schedule'` (not additive, approved the same day), so a person can send a delivered period again. `app.build_webhook_payload`, `include_check_sources` and `include_creatives` stay in the database, unused, until a separate approval drops them.
- Deferred because they need a new dependency: rate limiting on admin routes (`@fastify/rate-limit`), coverage (`@vitest/coverage-v8`), a metrics endpoint.

## Domain rules (non-negotiable)

1. **Replace, never increment.** A sync replaces the whole `(campaign, source, language, day)` slice in one transaction under `pg_advisory_xact_lock(hashtext(link_id))`.
2. **Every covered day is written, including empty ones.** Connectors return `covered` — the window they actually queried and vouch for. The engine replaces every day in it, so a day the source stopped reporting is cleared. A connector that did not query a day must not claim it; `null` means nothing was queried.
3. **Absent is not zero.** Mappers omit metrics a platform does not measure. Never write `0` for "not measured", never `COALESCE` it away in reads.
4. **Aggregate by the catalog.** `METRIC_AGGREGATION` / `METRIC_WEIGHT` in `src/modules/sync/types.ts` mirror `analytics.metric` (a test pins both). `sum` adds; `weighted_avg` is weighted by its weight metric; `none` (the `unique_*_reported` scalars) is **never added** — not across entities, days, tags or sources. Use `mergeRows`; do not hand-roll merges.
5. **Never sum across sources.** Each source is its own series; the campaign's `primary_source` is the headline.
6. **The cursor moves last.** `sync_state`, the unmapped queue and the run outcome commit together, only after every day's write committed.
7. **Days are explicit.** A day is the source's day in `external.source.day_timezone`. Use `todayIn` / `yesterdayIn` / `startOfDayIn` from `src/core/dates.ts`. Never derive a day from `new Date()` arithmetic or the server clock. `TZ` is pinned to UTC.
8. **Validate dates as round trips.** `assertIsoDate` rejects `2026-02-31`; zod schemas use `z.iso.date()`.

## Connectors (`src/modules/sync/connectors/<source>/`)

- Shape: `schema.ts` (zod, loose objects, only the fields read), `mapper.ts` (pure, no I/O), `connector.ts` (fetching), `errors.ts`, `fixtures/`.
- Read the **validated** config from `ctx.config`. Never re-parse `ctx.link.config`.
- Pass `signal: ctx.signal` and `log: ctx.log` to every request. Call `ctx.signal.throwIfAborted()` between chunks and entities.
- Persist raw responses with `await ctx.capture(raw)` **right after parsing each response**, never batched at the end — failed runs must keep their payloads. Redact the request before capturing.
- Verify every row belongs to the entity you asked for. Id filters are ambiguous (`external_id` vs `internal_id`); a row for another campaign is a `ConnectorContractError`, never silently attributed. Ask with the configured id param only: retrying the other one can return a different campaign that owns our id there.
- A response shared through `ctx.memo` must still narrow every reader's `covered` window (Zeus's own end-date clamp), not only the first link's.
- Check invariants on **every** report consumed: one row per entity per day, ratios (`clicks ≤ impressions`, …), non-negative integer counts, and the returned window equals the requested one. A contradiction the platform produces routinely on a never-summed per-day scalar (Zeus: `unique_clicks > clicks`) is a run warning and the value is stored as reported. Never clamp it.
- Errors: shape surprises extend `ConnectorContractError`; numbers that do not add up extend `VerificationError`.
- Responses identical across links (e.g. Zeus's unfiltered tracker) go through `ctx.memo.getOrLoad(key, …)`, keyed by credential, report and window.
- `checkConnection` answers `ok: true` only when the key is known to be accepted. 429 and 5xx mean "cannot tell" → `ok: false`. Give probes a `deadlineMs`.
- Vendor-supplied names are Map keys (`unmapped: Map<string, number>`), never plain-object keys.

## Engine and database

- `runSync` is the only entry point (scheduler, route, CLI). It cuts a requested window at the newest complete day in the source's day zone (`completeDays`) and refuses one with none (`422 window_not_complete`): no connector is ever asked for a day still being counted. Pass one process-wide `limiter` (`createLimiter(SYNC_MAX_CONNECTIONS)`), and in the service the shutdown `signal` and `tracker`.
- Runs are opened through `repo.openRun`: gate lock + status check + insert in one transaction. Never check-then-insert in separate statements.
- SQL lives in `sql/<name>.sql` beside the module and is loaded with `loadSql(import.meta.url, [...] as const)` at import time. Parameters only; bulk writes via `unnest` with typed arrays. If a statement's column order is positional (e.g. `METRIC_IDS` ↔ `insert_advanced.sql`), a test must read every column back by name.
- Session timeouts are set per connection in the pool's `onConnect` hook, never as startup parameters (a pooler may drop those). A test asserts `pg_settings.source = 'session'`.
- Go through `createDb`: it sets TLS verification, the idle-client error listener, `keepAlive`, max connection lifetime, statement / lock / idle-in-transaction timeouts, `application_name`, and DATE-as-string parsing. Do not construct `pg.Pool` elsewhere.
- A connection whose ROLLBACK or unlock failed is destroyed, never returned to the pool.
- Leader election uses `db.withAdvisoryLock` (two-integer keyspace, session lock). It needs a session: direct connection or Supavisor's **session** pooler (5432). Config rejects the transaction pooler (6543). Call `lease.assertHeld()` before irreversible work.
- Batch work never takes the whole pool: wrap it with `limitDb(db, limiter)`. The failure record (`failRun`) goes through the unlimited pool.
- Index every foreign-key column you add.
- **Row level security (0006).** Every table has RLS on; the service owns them and bypasses it. A new table needs its own `ENABLE ROW LEVEL SECURITY` in the migration that creates it. `authenticated` (a logged-in console user) may only SELECT the analytics tables, the operational tables the console shows, and `app.campaign`; `anon` has nothing. Never grant `external.credential`, `external.raw_payload`, or anything in `app` beyond `campaign` — `app.webhook` holds the signing secret and the client's key. Every logged-in user reads every company until a user↔company mapping exists, so anonymous sign-ins and public sign-ups stay off.

## Campaign setup (`src/modules/campaigns/`)

- `setUpCampaign` is the only way a campaign and its company are created or their own fields change (the company part — `lockCompany`, `resolveCompany` — lives in `modules/companies/service.ts` and runs in the setup's transaction), and the Salesforce report (`src/modules/salesforce/`) is its only caller in the service. Nobody creates, edits or deletes a campaign or a company by hand: there is no such route. Any future CRM adapter builds the same platform-neutral `CampaignSetup` (`input.ts`); no route or adapter writes those tables itself.
- A person sets **platform ids only**, through `setPlatformIds` / `removePlatform` (`PUT` / `DELETE /campaigns/:id/platforms/:platform`, one route pair per entry of `PLATFORM_PRESETS`). A `PUT` is the whole id list for that link. Adding ids is always allowed. Changing, dropping or removing is allowed only while the link has no analytics rows for its (campaign, source, language) and no real sync run is running, both read under the link's `sync-run-gate` lock (the lock a run opens under); then the link is deleted and rebuilt, so its sync state and runs go with it. Otherwise `409 platform_has_data` / `409 sync_in_progress`.
- The service knows no platform by name. What a source accepts comes from its connector (`identity.levels`, `identity.roles`, `describe().configSchema`), checked by `checkSources` before the first statement. Platform conventions — the Zeus `clickthrough` CTA, the two standard NEXD events, the headline order (`headlineSource`: Zeus if the campaign has Zeus ids, otherwise NEXD, Zeus with none) — live in `presets.ts`. The headline is recomputed whenever a person changes the links; a push never changes it unless it states one.
- A setup is repeatable by `externalRef`, and **a push only adds**: it updates the campaign's own fields and adds sources and entities that are new. It never removes an entity, never rewrites an existing one (a changed `campaign_tag` would split the rows) and cannot blank a field.
- One transaction, locks taken company first, then campaign (a platform-id change: campaign row, then link, then gate lock). A company name is never matched silently (`409 company_name_exists`): the company is the boundary a webhook reports across. A campaign never moves to another company.
- `idType` for Zeus is required, never defaulted. There is no delete route: deleting a campaign cascades to its analytics.
- A webhook's signing secret is minted in `createWebhook`, returned once, never listed and never logged. The client's key (`auth_token`) is write-only: listed as its header name, never the value.

## Salesforce report (`src/modules/salesforce/`, `POST /inbound/campaigns`)

- Another of our apps posts the daily "Committed Opps" report every morning. `report.ts` (pure) is the only place Salesforce field names appear; `ingest.ts` hands each row to `setUpCampaign` on its own.
- Mapping: `opportunity_id` → campaign `externalRef` `salesforce:<id>`; `opportunity_name` → name, prefix included; `account_name` → company, keyed by `companyKey` (lowercase snake_case, umlauts spelled out) because the report has no account id; dates; `creative_languages` → codes via `LANGUAGE_CODES`; `nn_price` + `currency` → price, always a CPM. Nothing else in a row is mapped, stored or logged. A price that cannot be stored exactly is left out with a warning, never rounded.
- The report is a snapshot that drops campaigns once they start: a missing row means nothing. Never archive or remove on absence.
- A row the setup service refuses (any `AppError` below 500) is reported in `rejected` and the others go on; anything else aborts the request with a 5xx so the sender retries. Retries are safe because a push that changes nothing writes nothing; there is no record of reports seen and none is needed.
- Refusal messages carry field paths, never values (deal terms, people's names). The summary log line has counts and opportunity ids only.

## Webhooks (`src/modules/webhooks/`)

- One minutely tick (`runWebhookTick`) behind leader lock key 2, never a timer per webhook. It enqueues due webhooks and then delivers due deliveries, both inside the tick's own `limitDb` share.
- Every attempt starts from a claim (`claim_next_delivery.sql`, `claim_delivery.sql`): a lease in `next_attempt_at` and the attempt counted, taken with `SKIP LOCKED`. `record_attempt.sql` lands only while the row is `pending` with that count. Never send from a plain SELECT.
- The `app.webhook_delivery` row is the idempotency record. Its id is minted before the document is rendered, rendered into it, inserted with it (`insert_delivery.sql`) and sent as `X-Delivery-Id`; it never changes across retries. The schedule makes one row per `(webhook, period)` (`webhook_delivery_scheduled_period`, a partial unique index), and a re-queue never changes a row's `trigger`, so it can never send a period twice. Send-now re-queues the period's latest row while it is pending or failed, and once it was delivered sends the period again as a new `manual` row with a new id — never overwriting a delivered row.
- A report is flat rows, one per campaign and day, from the webhook's ONE source (`payload_fields.source`, default `zeus`): `Date` and `Campaign` first, then the admin's columns in their order (`fields.ts`) — a formula or a fixed text, under the client's exact name. A day without a stored row has no report row; a period without rows is never sent (`empty_period` for send-now). Languages and creatives merge into the row with `mergeRows` (`rows.ts`).
- `buildReport` + `renderReport` (`build.ts`) are the only place a report is built — enqueue, send-now and preview all call them. The document (the JSON body, or the CSV) is rendered once, by hand so the client's column order survives, and stored as text in `payload`; what is signed, sent and served is that text.
- A scheduled report waits while a campaign in flight has an enabled link to the source whose `data_complete_through` is short of the period (`report_readiness.sql`): the webhook stays due until the data is there or 12:00 in its timezone on the day it was due (`waitDeadline`), then goes out with what there is. Send-now and preview never wait.
- Frequency (`daily` | `weekly` | `monthly`, stored in `report_window`) decides the period; the cron (default 05:00, Monday, the 1st) decides when it is sent.
- Sign the exact bytes: sign `X-Timestamp + "." + the body`, send that string as `bodyText`. Nothing may re-encode the body on the way out, and the timestamp is fixed once and sent exactly as signed.
- A `csv` webhook speaks Funnel's File Import webhook: each attempt POSTs a JSON string holding a fresh link, `GET /exports/<id>.csv?exp=&sig=` (`exports.ts`), signed with the webhook's secret over the id and an expiry 7 days out, with Funnel's token in `x-funnel-fileimport-token`. The link is the only key to the public route; every refusal is the same 404, and the route keeps Fastify's request lines off because the URL carries the signature. Links need `PUBLIC_BASE_URL` (or Render's `RENDER_EXTERNAL_URL`).
- The client's key goes in its own header after ours and can never be one we set (`OWN_HEADERS`); a csv webhook always has one. It is stripped from every stored excerpt.
- Delivery outcomes are data, not exceptions: a client's 500 is `pending` with the next rung of `RETRY_DELAYS_MS` (1 m, 5 m, 30 m, 2 h, 12 h); the 6th failure is `failed`. Only our own refusals throw (`src/modules/webhooks/errors.ts`).
- Formulas are parsed by `formula.ts` and walked as a tree: never `eval`, `Function` or SQL. Values are exact fractions, rounded once, half away from zero, computed for each row from that row's own numbers, never by adding results up; a missing input or a division by zero is `null`, never 0. `validateFields` checks every formula against `external.source_metric` before it is saved.
- Every attempt re-checks the target with `assertPublicTarget`, including on retries. The JSON body's shape is `reportBodySchema` (and `reportBodySchemaFor` for a column list), the CSV is `csv.ts`, and the client contract is `docs/WEBHOOK-PAYLOAD-v2.md`: change the renderer, the schema and the contract together.

## HTTP client (`src/core/http/HttpClient.ts`)

- Every outbound call goes through it: per-credential serialisation, streamed size cap, `redirect: 'error'`, typed errors (`HttpError`, `NetworkError` with cause code, `ResponseBodyError`, `ResponseTooLargeError`, `DeadlineExceededError`, `RetryBudgetExhaustedError`).
- Retry only what can succeed on retry: 408, 429, 5xx except 501/505, and network errors with a transient cause code. Everything else fails on the first attempt.
- Use `res.json()` (throws a typed body error), not `JSON.parse(res.text)`.

## Secrets, logging, errors

- Secrets exist only in environment variables, but for the two a webhook carries in `app.webhook` (its signing secret and the client's key; RFC-002 §15.5, migration 0008). `external.credential.secret_env_var` is a pointer and must match the credential shape enforced by `assertSecretPointer`; it can never name a variable the service itself reads.
- The logger redacts **explicit paths** (`src/core/log.ts`). When you log a new object that can carry a secret, add its path and a case to `tests/unit/log.test.ts`. Pass unknown shapes through `redact()` first. Never log a presented token — log why it was refused.
- Anything persisted or put in an error message (`sync_run.error`, `HttpError.message`, raw payloads) is redacted, including URL query parameters and body excerpts.
- Throw typed errors with a stable `code`, `retryable` and `status`: they all extend `AppError` (`src/core/errors.ts`), per module in `src/modules/sync/errors.ts` and `src/modules/webhooks/errors.ts`. Wrap foreign errors with `{ cause }`. The route layer maps through `classifySyncError`.

## Fastify

- Admin routes register inside the `ADMIN_PREFIXES` scopes in `src/app.ts`, whose auth hook runs before any route lookup or 404. Never add an admin route at the root.
- Routes other systems push to register inside the `INBOUND_PREFIX` scope, behind `INBOUND_CAMPAIGNS_TOKEN` (at least 32 characters, never equal to the admin token, a reserved name in `secrets.ts`). Unset, the scope does not exist. An inbound token never opens an admin route and the admin token never opens an inbound one.
- `EXPORT_PREFIX` (`/exports`) is the one public scope: a csv webhook's file behind its signed link, and nothing else.
- Route schemas are zod (compilers wired at the root). Throw typed errors; the root handler maps statuses and never echoes a message for 5xx.
- `app.close()` is the single shutdown path: it drains in-flight runs, then closes the pool. Do not close the pool separately.
- Health probes stay silent in the logs; a failed `/readyz` logs pool stats. Sync and webhook failures never affect readiness.

## Tests

- Unit tests never touch a database; integration tests run against the local Supabase stack. Inject clocks, `random`, `sleep` and `fetch` instead of waiting on real time.
- Every test asserts something (`requireAssertions` is on; `passWithNoTests` is off).
- Test the failure path the code exists for: partial failures, aborted runs, restated days, cleared days, a disagreeing entity, a hostile body, a malformed date. A guard without a test that trips it does not count.
- Integration tests restore any shared seed they mutate in `afterEach`, clean their rows in `afterAll`, and use natural keys no other test file writes.
- Close every Fastify instance and pool a test creates.
- Fixture fakes answer for the requested window (`from`/`to` included), like the real API.

## Open questions that change code (do not guess)

- Which Zeus tracker field carries our ATK identity (`code`, `external_id`, `name`) — the connector matches all three until step 14 confirms.
- The day timezone of NEXD and Zeus — seeded as UTC; set `external.source.day_timezone` when support answers.
- Webhook secret rotation: the signature covers the timestamp and the exact bytes, which carry the delivery id; supporting two active secrets for rotation still needs an additive column, so confirm with the RFC-004 owner first.
