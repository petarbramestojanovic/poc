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
│  campaigns/       one setup service: a form, curl or a CRM push all use it  │
│  routes/          /companies · /campaigns · /webhooks · /sync (bearer token)│
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

4. Create the campaign with the service running (`npm run dev`). One call creates the company, the campaign, the `clickthrough` CTA, a link per platform and its ids, in one transaction. Replace every `<…>`; leave out the platform you do not have.

   ```sh
   curl -X POST http://127.0.0.1:3000/campaigns \
     -H 'authorization: Bearer <token>' -H 'content-type: application/json' -d '{
       "company": { "name": "<client>" },
       "name": "<campaign name>",
       "primarySource": "zeus",
       "startsOn": "<YYYY-MM-DD>", "endsOn": "<YYYY-MM-DD>",
       "sources": {
         "zeus": { "campaignId": "<campaign id>", "idType": "internal_id",
                   "pixels": [ { "code": "<pixel>", "role": "engagement" },
                               { "code": "<pixel>", "role": "finish" } ] },
         "nexd": { "creatives": [ { "liveId": "<live id>", "label": "<label>" } ] }
       } }'
   ```

   `idType` says which of Zeus's two ids `campaignId` is, and is never defaulted: the wrong one returns another campaign's rows or nothing. The response lists the link ids to sync. The same form is in the temporary console (`npm run sync-console`, Campaigns tab).

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

## Campaign setup API

Companies, campaigns and webhooks are created through admin routes (bearer token), never by SQL. All of them go through one service, `src/campaigns/`, whose input is platform-neutral: the routes, the console form and — later — a CRM adapter build the same `CampaignSetup` and call `setUpCampaign`.

| Route                                                | What it does                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /companies` · `POST /companies`                 | List; create (or, with a known `externalRef`, rename)                              |
| `GET /campaigns[?companyId=]` · `GET /campaigns/:id` | List with links; one campaign with its platform ids                                |
| `POST /campaigns`                                    | Set a campaign up: `201` created, `200` when its `externalRef` was already known   |
| `PATCH /campaigns/:id`                               | Edit name, dates, status, headline source, timezone, languages. There is no delete |
| `GET /webhooks` · `POST /webhooks`                   | List (never a secret); create — the signing secret is in this response only        |

**Pushing from another system.** Send `"externalRef": { "system": "salesforce", "id": "<its id>" }` (on the company too) and the call becomes repeatable: the second push finds the campaign it created, updates its own fields and **adds** any source, pixel or creative that is new. It never removes anything and cannot blank a field, so a half-filled CRM record cannot stop a working sync. Refusals are explicit: `409 entity_in_use` names the campaign that already owns a platform id, `409 company_name_exists` asks for `company.id` rather than guessing between namesakes, `422 primary_source_required` when a new campaign has no source or several.

A new platform needs one preset in `src/campaigns/presets.ts`; a new CRM needs one adapter that builds a `CampaignSetup`. Neither touches the service.

## Client report webhooks

A webhook is a row in `app.webhook`, created with `POST /webhooks`: the client's HTTPS endpoint, a
signing secret we generate and show once, a cron expression with a timezone, and which campaigns it
covers. A minutely tick enqueues the period
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
