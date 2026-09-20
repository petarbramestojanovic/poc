# CLAUDE.md — analytics-be

Phase 1 of the standalone analytics product: nightly and on-demand sync of **NEXD** and **Zeus (ATK)** analytics into Postgres, then signed, scheduled report webhooks to clients. One Node service (Render) plus one Supabase Postgres project. No UI in phase 1.

Design of record, in order of precedence: [RFC-004](docs/RFC-004-phase1-database-schema.md) (schema), [RFC-003](docs/RFC-003-external-analytics-adapter.md) (connectors, sync), [RFC-002](docs/RFC-002-standalone-analytics-app-supabase.md) (platform), [phase 1 plan](docs/PHASE1-PLAN-PROMPT.md) (steps and done-when criteria). When this file and an RFC disagree, the RFC wins; say so instead of picking silently.

The rules below are distilled from the September 2026 code review of steps 1–7 (69 findings). Most of them exist because a guard was declared but did not hold under the condition it was written for. Keep the guards real.

## Commands

```sh
npm run typecheck          # tsc --noEmit over src, tests, scripts
npm run lint               # type-aware ESLint + Prettier check
npm test                   # unit tests, no database
npm run test:integration   # needs `npx supabase start` and DATABASE_URL (see .env.example)
npm run build && npm run build:smoke   # compile, copy sql/, import the built modules
npx supabase migration up  # apply new migrations locally; `npm run db:reset` recreates + seeds
```

A change is done when `typecheck`, `lint`, `test` and `test:integration` are all green. Run `build:smoke` whenever you add, rename or move a `.sql` file or touch the build.

## Scope and change control

- **Ask first** before: changing anything RFC-004 defines (tables, columns, keys, seeds), adding a dependency outside the fixed stack (Fastify, pg, zod, pino, node-cron, cron-parser, Vitest, ESLint, Prettier, Supabase CLI), or building phase 2 work (dashboard, Supabase Auth users, RLS, own ingestion routes, `source = 'brame'` rows, HLL, CSV export, retention purge, backfill, device split).
- **Additive migrations only.** New indexes are fine and must be flagged in the PR. Never edit an applied migration; add the next numbered file.
- **Approved deviations from RFC-004** (the RFC files stay verbatim; the migration header is the record): `0004_external_refs.sql` adds `external_system` + `external_id` to `app.company` and `app.campaign` (2026-09-20), so another system can push the same record twice. They identify a row and never describe it: no CRM field belongs in the model.
- Deferred because they need a new dependency: rate limiting on admin routes (`@fastify/rate-limit`), coverage (`@vitest/coverage-v8`), a metrics endpoint.

## Domain rules (non-negotiable)

1. **Replace, never increment.** A sync replaces the whole `(campaign, source, language, day)` slice in one transaction under `pg_advisory_xact_lock(hashtext(link_id))`.
2. **Every covered day is written, including empty ones.** Connectors return `covered` — the window they actually queried and vouch for. The engine replaces every day in it, so a day the source stopped reporting is cleared. A connector that did not query a day must not claim it; `null` means nothing was queried.
3. **Absent is not zero.** Mappers omit metrics a platform does not measure. Never write `0` for "not measured", never `COALESCE` it away in reads.
4. **Aggregate by the catalog.** `METRIC_AGGREGATION` / `METRIC_WEIGHT` in `src/sync/types.ts` mirror `analytics.metric` (a test pins both). `sum` adds; `weighted_avg` is weighted by its weight metric; `none` (the `unique_*_reported` scalars) is **never added** — not across entities, days, tags or sources. Use `mergeRows`; do not hand-roll merges.
5. **Never sum across sources.** Each source is its own series; the campaign's `primary_source` is the headline.
6. **The cursor moves last.** `sync_state`, the unmapped queue and the run outcome commit together, only after every day's write committed.
7. **Days are explicit.** A day is the source's day in `external.source.day_timezone`. Use `todayIn` / `yesterdayIn` / `startOfDayIn` from `src/dates.ts`. Never derive a day from `new Date()` arithmetic or the server clock. `TZ` is pinned to UTC.
8. **Validate dates as round trips.** `assertIsoDate` rejects `2026-02-31`; zod schemas use `z.iso.date()`.

## Connectors (`src/sync/connectors/<source>/`)

- Shape: `schema.ts` (zod, loose objects, only the fields read), `mapper.ts` (pure, no I/O), `connector.ts` (fetching), `errors.ts`, `fixtures/`.
- Read the **validated** config from `ctx.config`. Never re-parse `ctx.link.config`.
- Pass `signal: ctx.signal` and `log: ctx.log` to every request. Call `ctx.signal.throwIfAborted()` between chunks and entities.
- Persist raw responses with `await ctx.capture(raw)` **right after parsing each response**, never batched at the end — failed runs must keep their payloads. Redact the request before capturing.
- Verify every row belongs to the entity you asked for. Id filters are ambiguous (`external_id` vs `internal_id`); a row for another campaign is a `ConnectorContractError`, never silently attributed.
- Check invariants on **every** report consumed: one row per entity per day, ratios (`clicks ≤ impressions`, …), non-negative integer counts, and the returned window equals the requested one. A contradiction the platform produces routinely on a never-summed per-day scalar (Zeus: `unique_clicks > clicks`) is a run warning and the value is stored as reported. Never clamp it.
- Errors: shape surprises extend `ConnectorContractError`; numbers that do not add up extend `VerificationError`.
- Responses identical across links (e.g. Zeus's unfiltered tracker) go through `ctx.memo.getOrLoad(key, …)`, keyed by credential, report and window.
- `checkConnection` answers `ok: true` only when the key is known to be accepted. 429 and 5xx mean "cannot tell" → `ok: false`. Give probes a `deadlineMs`.
- Vendor-supplied names are Map keys (`unmapped: Map<string, number>`), never plain-object keys.

## Engine and database

- `runSync` is the only entry point (scheduler, route, CLI). Pass one process-wide `limiter` (`createLimiter(SYNC_MAX_CONNECTIONS)`), and in the service the shutdown `signal` and `tracker`.
- Runs are opened through `repo.openRun`: gate lock + status check + insert in one transaction. Never check-then-insert in separate statements.
- SQL lives in `sql/<name>.sql` beside the module and is loaded with `loadSql(import.meta.url, [...] as const)` at import time. Parameters only; bulk writes via `unnest` with typed arrays. If a statement's column order is positional (e.g. `METRIC_IDS` ↔ `insert_advanced.sql`), a test must read every column back by name.
- Go through `createDb`: it sets TLS verification, the idle-client error listener, `keepAlive`, max connection lifetime, statement / lock / idle-in-transaction timeouts, `application_name`, and DATE-as-string parsing. Do not construct `pg.Pool` elsewhere.
- A connection whose ROLLBACK or unlock failed is destroyed, never returned to the pool.
- Leader election uses `db.withAdvisoryLock` (two-integer keyspace, session lock). It needs a session: direct connection or Supavisor's **session** pooler (5432). Config rejects the transaction pooler (6543). Call `lease.assertHeld()` before irreversible work.
- Batch work never takes the whole pool: wrap it with `limitDb(db, limiter)`. The failure record (`failRun`) goes through the unlimited pool.
- Index every foreign-key column you add.

## Campaign setup (`src/campaigns/`)

- `setUpCampaign` is the only way a campaign, its links and its platform ids are written. The routes, the console form and any future CRM adapter build the same platform-neutral `CampaignSetup` (`input.ts`) and call it. No route or adapter writes those tables itself.
- The service knows no platform by name. What a source accepts comes from its connector (`identity.levels`, `identity.roles`, `describe().configSchema`), checked by `checkSources` before the first statement. Platform conventions — the Zeus `clickthrough` CTA, the two standard NEXD events — live in `presets.ts`, one preset per platform.
- A setup is repeatable by `externalRef`, and **a push only adds**: it updates the campaign's own fields and adds sources and entities that are new. It never removes an entity, never rewrites an existing one (a changed `campaign_tag` would split the rows) and cannot blank a field. Removing is a deliberate act by a person.
- One transaction, locks taken company first, then campaign. A company name is never matched silently (`409 company_name_exists`): the company is the boundary a webhook reports across. A campaign never moves to another company.
- `idType` for Zeus is required, never defaulted. There is no delete route: deleting a campaign cascades to its analytics.
- A webhook's signing secret is minted in `createWebhook`, returned once, never listed and never logged.

## Webhooks (`src/webhooks/`)

- One minutely tick (`runWebhookTick`) behind leader lock key 2, never a timer per webhook. It enqueues due webhooks and then delivers due deliveries, both inside the tick's own `limitDb` share.
- The `app.webhook_delivery` row is the idempotency record: one per `(webhook, period)`, its id stamped into the payload at insert (`insert_delivery.sql`) and sent as `X-Delivery-Id`. It never changes across retries, and a delivered period is never re-queued.
- Sign the exact bytes: `JSON.stringify` once, sign that string, send it as `bodyText`. Nothing may re-encode the body on the way out.
- Delivery outcomes are data, not exceptions: a client's 500 is `pending` with the next rung of `RETRY_DELAYS_MS`; the 5th failure is `failed`. Only our own refusals throw (`src/webhooks/errors.ts`).
- Every attempt re-checks the target with `assertPublicTarget`, including on retries. The payload shape is `webhookPayloadSchema` and the client contract is `docs/WEBHOOK-PAYLOAD-v1.md`: change all three together.

## HTTP client (`src/http/HttpClient.ts`)

- Every outbound call goes through it: per-credential serialisation, streamed size cap, `redirect: 'error'`, typed errors (`HttpError`, `NetworkError` with cause code, `ResponseBodyError`, `ResponseTooLargeError`, `DeadlineExceededError`, `RetryBudgetExhaustedError`).
- Retry only what can succeed on retry: 408, 429, 5xx except 501/505, and network errors with a transient cause code. Everything else fails on the first attempt.
- Use `res.json()` (throws a typed body error), not `JSON.parse(res.text)`.

## Secrets, logging, errors

- Secrets exist only in environment variables. `external.credential.secret_env_var` is a pointer and must match the credential shape enforced by `assertSecretPointer`; it can never name a variable the service itself reads.
- The logger redacts **explicit paths** (`src/log.ts`). When you log a new object that can carry a secret, add its path and a case to `tests/unit/log.test.ts`. Pass unknown shapes through `redact()` first. Never log a presented token — log why it was refused.
- Anything persisted or put in an error message (`sync_run.error`, `HttpError.message`, raw payloads) is redacted, including URL query parameters and body excerpts.
- Throw typed errors with a stable `code`, `retryable` and `status`: they all extend `AppError` (`src/errors.ts`), per module in `src/sync/errors.ts` and `src/webhooks/errors.ts`. Wrap foreign errors with `{ cause }`. The route layer maps through `classifySyncError`.

## Fastify

- Admin routes register inside the `ADMIN_PREFIXES` scopes in `src/app.ts`, whose auth hook runs before any route lookup or 404. Never add an admin route at the root.
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
- Webhook signing (step 11): sign the exact serialised bytes, include the delivery id in the signed input, support two active secrets for rotation — the last needs an additive column, so confirm with the RFC-004 owner first.
