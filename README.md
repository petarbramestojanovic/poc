# analytics-be

Phase 1 of the standalone analytics product for playable-ad campaigns. Some creatives are served by third-party ad platforms that own the analytics: **NEXD** and **Zeus** (the adserver behind our ATK tracking pixels). This service pulls those numbers into our own Postgres nightly and on demand, stores them as day-replaced rows per source (never summed across sources), and pushes a signed, versioned JSON report to each client's HTTPS endpoint on a per-client schedule. It is one Node service on Render plus one Supabase Postgres project; there is no UI in phase 1, operators use the CLI.

Design of record: [RFC-004](docs/RFC-004-phase1-database-schema.md) (schema), [RFC-003](docs/RFC-003-external-analytics-adapter.md) (connectors and sync), [RFC-002](docs/RFC-002-standalone-analytics-app-supabase.md) (platform), and the [phase 1 plan](docs/PHASE1-PLAN-PROMPT.md). Working rules for contributors and coding agents: [CLAUDE.md](CLAUDE.md).

## Architecture

```
  NEXD API            Zeus (ATK) API                    client endpoint
      ▲                     ▲                                  ▲
      │ HttpClient          │ HttpClient                       │ POST, signed
      │ (retries, size cap, │                                  │ (X-Signature)
      │  no redirects)      │                                  │
┌─────┴─────────────────────┴──────────────────────────────────┴──────────────┐
│ analytics-be (Node 24, Fastify)                                             │
│                                                                             │
│  sync/            connectors → mapper → engine → day-replace writer         │
│    nightly pass   04:00 Europe/Zurich, leader lock key 1                    │
│  webhooks/        minutely tick, leader lock key 2 → build, sign, deliver   │
│  routes/          POST /sync/links/:id/run · GET /sync/runs/:id             │
│                   POST /webhooks/:id/send-now        (bearer token)         │
│                   GET /healthz · GET /readyz                                │
│  cli/             npm run sync -- …                                         │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ pg pool (10 per instance; sync ≤ 3, webhooks ≤ 2)
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Supabase Postgres                                                           │
│  app.*        company · campaign · webhook · webhook_delivery               │
│  analytics.*  metric catalog · advanced_analytics · page_views · cta_clicks │
│               + the RFC-004 §7 read functions and build_webhook_payload     │
│  external.*   source · credential (pointers) · campaign_link · link_entity  │
│               event_map · sync_state · sync_run · raw_payload               │
└─────────────────────────────────────────────────────────────────────────────┘
```

Every replica schedules both jobs and a Postgres advisory lock picks the one that runs it, so
scaling out adds capacity without duplicating work. Secrets stay in environment variables — the
database holds only the _name_ of the variable — with one deliberate exception: a webhook's signing
secret, which we mint per client and which signs nothing but our own payloads.

Reads never sum across sources: every function answers for one source, and a campaign's
`primary_source` is its headline. The details that a client's integration depends on are in
[docs/WEBHOOK-PAYLOAD-v1.md](docs/WEBHOOK-PAYLOAD-v1.md); how to operate all of it is in
[docs/RUNBOOK.md](docs/RUNBOOK.md).

## Stack

Node 24 (>= 22.18), TypeScript strict ESM, Fastify, `pg`, zod, pino, node-cron + cron-parser, Vitest, ESLint + Prettier, Supabase CLI for migrations and the local stack.

TypeScript source runs directly on Node (native type stripping), so imports use `.ts` extensions and `tsc` rewrites them to `.js` in `dist/`. Keep the code to erasable syntax only (no `enum`, no `namespace`, no parameter properties); the compiler enforces it.

## Local development

Prerequisites: Node 24 (`.nvmrc`), Docker (for the local Supabase stack).

```sh
npm ci
cp .env.example .env            # fill in what you need; .env is git-ignored
npx supabase start               # local Postgres + Studio (from step 2 on)
npm run db:reset                 # apply migrations + seed.sql
npm run dev                      # service with file watching
```

## Sync against the real APIs locally

With real keys you can sync into your local database and inspect the rows directly. Use a campaign of your own rather than the seeded one, because the integration tests reset the seeded campaign's rows.

1. Put `NEXD_API_KEY` and `ZEUS_API_TOKEN` in `.env`.

2. Check both keys. The result is recorded on the credential row.

   ```sh
   npm run sync -- --check-connection nexd-main
   npm run sync -- --check-connection zeus-main
   ```

3. List the ATK pixels the Zeus token can see, and note which column (`code`, `external_id` or `name`) carries the ATK identity.

   ```sh
   npm run sync -- --source zeus --list-pixels
   ```

4. Create a campaign and its links in Studio (http://127.0.0.1:54323) or psql. Replace every `<…>`.

   ```sql
   -- Campaign under the seeded company, plus the CTA Zeus clicks are written to.
   INSERT INTO app.campaign (id, company_id, name, primary_source, starts_on, ends_on) VALUES
     ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
      '<campaign name>', 'zeus', '<YYYY-MM-DD>', '<YYYY-MM-DD>');
   INSERT INTO analytics.cta (campaign_id, cta_id, name) VALUES
     ('10000000-0000-4000-8000-000000000001', 'clickthrough', 'Click-out');

   -- NEXD: one creative row per live id. campaign_tag names the creative in the breakdown.
   INSERT INTO external.campaign_link (id, campaign_id, source_id, credential_id, language) VALUES
     ('10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'nexd',
      '00000000-0000-4000-8000-000000000011', '<language>');
   INSERT INTO external.link_entity (link_id, source_id, level, external_id, label, campaign_tag) VALUES
     ('10000000-0000-4000-8000-000000000011', 'nexd', 'creative', '<live id>', '<label>', '<live id>');

   -- Zeus: the campaign, its creatives, and the engagement and finish pixels from step 3.
   -- Set "campaign_id_param" to "internal_id" when the campaign id is Zeus's internal id.
   INSERT INTO external.campaign_link (id, campaign_id, source_id, credential_id, language, config) VALUES
     ('10000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', 'zeus',
      '00000000-0000-4000-8000-000000000012', '<language>',
      '{"clickthrough_cta_id": "clickthrough", "campaign_id_param": "external_id"}');
   INSERT INTO external.link_entity (link_id, source_id, level, external_id, role, label, campaign_tag) VALUES
     ('10000000-0000-4000-8000-000000000012', 'zeus', 'campaign', '<campaign id>', NULL, NULL, ''),
     ('10000000-0000-4000-8000-000000000012', 'zeus', 'creative', '<creative_id>', NULL, '<label>', '<tag>'),
     ('10000000-0000-4000-8000-000000000012', 'zeus', 'pixel', '<pixel>', 'engagement', NULL, '<tag>'),
     ('10000000-0000-4000-8000-000000000012', 'zeus', 'pixel', '<pixel>', 'finish', NULL, '<tag>');
   ```

5. Preview a window, then write it. `--trigger backfill` skips the five-minute cooldown between manual runs.

   ```sh
   npm run sync -- --link 10000000-0000-4000-8000-000000000012 --from 2026-09-01 --to 2026-09-07 --dry-run
   npm run sync -- --link 10000000-0000-4000-8000-000000000012 --from 2026-09-01 --to 2026-09-07 --trigger backfill
   ```

6. Inspect `external.sync_run`, `analytics.advanced_analytics`, `analytics.cta_clicks`, `analytics.page_views`, `external.raw_payload` and `external.unmapped_event`. NEXD event names with no mapping land in `external.unmapped_event`; add them to `external.event_map` and sync again.

`npm run sync -- --all` runs the nightly pass over every enabled link. It skips campaigns that are archived, not started yet, or finished before the 35-day deep lookback. `npm run db:reset` removes everything you created.

### Trigger a sync over HTTP

With the service running (`npm run dev`), trigger a link and poll its run. Replace `<token>` with `SERVICE_ADMIN_TOKEN`.

```sh
curl -X POST http://127.0.0.1:3000/sync/links/10000000-0000-4000-8000-000000000012/run \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"from": "2026-09-01", "to": "2026-09-07"}'
curl http://127.0.0.1:3000/sync/runs/<sync run id> -H 'authorization: Bearer <token>'
```

The trigger answers `202` with the run id as soon as the run is open, `429` inside the five-minute cooldown and `409` while the link already has a run in progress. A body of `{}` syncs the source's lookback ending yesterday. `"dryRun": true` records a dry run; only the CLI prints its diff. Windows longer than 366 days belong to the CLI.

## Scripts

| Script                     | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run dev`              | Run `src/index.ts` on Node with `--watch`, loading `.env`         |
| `npm run build`            | Clean `dist/`, compile `src/`, copy the `sql/` directories        |
| `npm run build:smoke`      | Import the built modules, proving every `.sql` file was copied    |
| `npm start`                | Run the compiled service with source maps (`dist/index.js`)       |
| `npm run sync -- …`        | Operator sync CLI: one link, the nightly pass, key checks, pixels |
| `npm run typecheck`        | `tsc --noEmit` over `src/`, `tests/` and config files             |
| `npm run lint`             | ESLint (type-aware) + Prettier check                              |
| `npm run lint:fix`         | Same, applying fixes                                              |
| `npm test`                 | Unit tests (Vitest project `unit`, no database needed)            |
| `npm run test:integration` | Integration tests against the local Supabase Postgres             |
| `npm run test:all`         | Both Vitest projects                                              |
| `npm run db:reset`         | `supabase db reset`: recreate the local DB from migrations + seed |

## Environment variables

See [.env.example](.env.example). Secrets live only in environment variables (locally in `.env`, on Render in the dashboard). `external.credential` rows store the _name_ of the variable, never the value.

| Variable                    | Purpose                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Postgres URL: local direct; on Render the session pooler (5432) or direct, never the transaction pooler (6543) |
| `DATABASE_SSL`              | `verify-full` (default) or `disable` (loopback hosts only)                                                     |
| `DATABASE_SSL_CA`           | PEM of the database CA; empty uses the system CAs                                                              |
| `NEXD_API_KEY`              | NEXD bearer key                                                                                                |
| `ZEUS_API_TOKEN`            | Zeus bearer token                                                                                              |
| `SERVICE_ADMIN_TOKEN`       | Bearer token for `/sync/*` and `/webhooks/*` routes, at least 32 characters                                    |
| `PORT`                      | HTTP port                                                                                                      |
| `LOG_LEVEL`                 | pino level                                                                                                     |
| `TRUST_PROXY_HOPS`          | Reverse proxies in front: 0 locally, 1 on Render, 2 with Cloudflare                                            |
| `SYNC_SCHEDULER_ENABLED`    | Run the 04:00 Europe/Zurich nightly pass in this process (default `true`)                                      |
| `WEBHOOK_SCHEDULER_ENABLED` | Run the minutely webhook tick in this process (default `true`)                                                 |
| `TZ`                        | Always `UTC`; sources and schedules carry explicit timezones                                                   |

## Client report webhooks

A webhook is a row in `app.webhook`: the client's HTTPS endpoint, a signing secret we generate, a
cron expression with a timezone, and which campaigns it covers. A minutely tick enqueues the period
that has closed, builds the body in Postgres, signs the exact bytes it sends and POSTs them; one
`app.webhook_delivery` row per (webhook, period) is the idempotency record and its id is the
`X-Delivery-Id` header. Failures retry at 1 min, 5 min, 30 min and 2 h, five attempts in all.

```sh
# an out-of-schedule delivery, e.g. to test a new endpoint
curl -X POST http://127.0.0.1:3000/webhooks/<webhook id>/send-now \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"period_start": "2026-09-07", "period_end": "2026-09-13"}'
```

The body a client receives, and the rules for reading its numbers, are documented for them in
[docs/WEBHOOK-PAYLOAD-v1.md](docs/WEBHOOK-PAYLOAD-v1.md). Setting one up from scratch is
[docs/RUNBOOK.md §2–3](docs/RUNBOOK.md).

## Branches

`main` is the dev environment, `prod` is production; both change through pull requests only. Each build step lands on its own feature branch with a green `typecheck`, `lint` and `test`.
