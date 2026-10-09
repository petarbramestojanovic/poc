# analytics-be

Phase 1 of the standalone analytics product for playable-ad campaigns. Some creatives are served by third-party ad platforms that own the analytics: **NEXD** and **Zeus** (the adserver behind our ATK tracking pixels). This service pulls those numbers into our own Postgres nightly and on demand, stores them as day-replaced rows per source (never summed across sources), and pushes a signed, versioned JSON report to each client's HTTPS endpoint on a per-client schedule. It is one Node service on Render plus one Supabase Postgres project; there is no UI in phase 1, operators use the CLI.

Design of record: RFC-004 (schema), RFC-003 (connectors and sync), RFC-002 (platform), and the phase 1 plan. This repo holds the application only; those documents, the runbook and the client payload contract live in a `docs/` folder beside it that is deliberately not committed. Working rules for contributors and coding agents: [CLAUDE.md](CLAUDE.md).

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
│  modules/                                                                   │
│    sync/          connectors → mapper → engine → day-replace writer         │
│                   nightly pass 04:00 Europe/Zurich, leader lock key 1       │
│    webhooks/      minutely tick, leader lock key 2 → build, sign, deliver   │
│    salesforce/    the daily report → campaigns (POST /inbound/campaigns)    │
│    campaigns/     one setup service; people set platform ids only           │
│    companies/     found or created inside a campaign setup; GET /companies  │
│    health/        GET /healthz · GET /readyz                                │
│  core/            config · db · log · errors · dates · http client · auth   │
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
`primary_source` is its headline. The details that a client's integration depends on are in `docs/WEBHOOK-PAYLOAD-v1.md`; how to
operate all of it is in `docs/RUNBOOK.md`. Both are kept outside this repo.

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

4. With the service running (`npm run dev`, `INBOUND_CAMPAIGNS_TOKEN` set in `.env`), create the campaign the way production does: push a one-row Salesforce report, then give the campaign its platform ids. Replace every `<…>`; leave out the platform you do not have.

   ```sh
   curl -X POST http://127.0.0.1:3000/inbound/campaigns \
     -H 'authorization: Bearer <inbound token>' -H 'content-type: application/json' -d '{
       "source": "salesforce_report", "record_count": 1, "campaigns": [ {
         "opportunity_id": "006<12 or 15 letters and digits>", "opportunity_name": "<AT2610 name>",
         "account_name": "<client>", "campaign_start_date": "<YYYY-MM-DD>",
         "campaign_end_date": "<YYYY-MM-DD>", "creative_languages": "German",
         "nn_price": <CPM>, "currency": "EUR" } ] }'

   curl -X PUT http://127.0.0.1:3000/campaigns/<campaign id>/platforms/zeus \
     -H 'authorization: Bearer <admin token>' -H 'content-type: application/json' -d '{
       "campaignId": "<campaign id>", "idType": "internal_id",
       "pixels": [ { "code": "<pixel>", "role": "engagement" },
                   { "code": "<pixel>", "role": "finish" } ] }'

   curl -X PUT http://127.0.0.1:3000/campaigns/<campaign id>/platforms/nexd \
     -H 'authorization: Bearer <admin token>' -H 'content-type: application/json' -d '{
       "creatives": [ { "liveId": "<live id>", "label": "<label>" } ] }'
   ```

   `GET /campaigns` gives the campaign id. `idType` says which of Zeus's two ids `campaignId` is, and is never defaulted: the wrong one returns another campaign's rows or nothing. The `PUT` answers with the campaign and its link ids to sync. The console (`dev/console`) has the same id forms.

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

| Script                     | What it does                                                        |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run dev`              | Run `src/index.ts` on Node with `--watch`, loading `.env`           |
| `npm run build`            | Clean `dist/`, compile `src/`, copy the `sql/` directories          |
| `npm run build:smoke`      | Import the built modules, proving every `.sql` file was copied      |
| `npm run check:migrations` | `-- <base-ref>`: fail if a migration on the base was edited/removed |
| `npm start`                | Run the compiled service with source maps (`dist/index.js`)         |
| `npm run sync -- …`        | Operator sync CLI: one link, the nightly pass, key checks, pixels   |
| `npm run typecheck`        | `tsc --noEmit` over `src/`, `tests/` and config files               |
| `npm run lint`             | ESLint (type-aware) + Prettier check                                |
| `npm run lint:fix`         | Same, applying fixes                                                |
| `npm test`                 | Unit tests (Vitest project `unit`, no database needed)              |
| `npm run test:integration` | Integration tests against the local Supabase Postgres               |
| `npm run test:all`         | Both Vitest projects                                                |
| `npm run db:reset`         | `supabase db reset`: recreate the local DB from migrations + seed   |

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
| `INBOUND_CAMPAIGNS_TOKEN`   | Bearer token of `POST /inbound/campaigns`, different from the admin token; unset = no such route               |
| `PORT`                      | HTTP port                                                                                                      |
| `LOG_LEVEL`                 | pino level                                                                                                     |
| `TRUST_PROXY_HOPS`          | Reverse proxies in front: 0 locally, 1 on Render, 2 with Cloudflare                                            |
| `SYNC_SCHEDULER_ENABLED`    | Run the 04:00 Europe/Zurich nightly pass in this process (default `true`)                                      |
| `WEBHOOK_SCHEDULER_ENABLED` | Run the minutely webhook tick in this process (default `true`)                                                 |
| `RENDER_GIT_COMMIT`         | Set by Render; `/healthz` reports it so a deploy can wait for its own commit                                   |
| `TZ`                        | Always `UTC`; sources and schedules carry explicit timezones                                                   |

## Campaigns

**Campaigns come from Salesforce.** Every morning another of our apps posts the "Media Solutions - Committed Opps - Daily" report to `POST /inbound/campaigns`, with its own bearer token (`INBOUND_CAMPAIGNS_TOKEN`), never the admin one. Each row becomes a campaign through the one setup service, `src/modules/campaigns/` (`setUpCampaign`); `src/modules/salesforce/` is the adapter, and Salesforce's field names stop there.

| Report field                               | Campaign                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `opportunity_id`                           | `externalRef` `salesforce:<id>`: the same opportunity tomorrow updates the same campaign                                    |
| `opportunity_name`                         | name, as sold (`AT2610 …`: market and month stay in the name)                                                               |
| `account_name`                             | company; its id is the name in snake_case (`Kaffeerösterei GmbH` → `kaffeeroesterei_gmbh`), as the report has no account id |
| `campaign_start_date`, `campaign_end_date` | flight                                                                                                                      |
| `creative_languages`                       | languages (`German` → `de`)                                                                                                 |
| `nn_price` + `currency`                    | price: always a CPM, whatever the billing type                                                                              |

Everything else in a row is ignored and never stored. A push only creates and updates: a campaign missing from today's report is left alone (the report drops campaigns once they start), a field it leaves out is never cleared, and a campaign never moves to another company. The answer is `200` with what happened to each row (`created`, `updated`, `unchanged`, `rejected` with a reason, `warnings`); the same report sent twice changes nothing.

**People set platform ids, and nothing else.** A campaign arrives without NEXD or Zeus ids:

| Route (admin token)                                  | What it does                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /companies`                                     | Companies with their campaign counts                                        |
| `GET /campaigns[?companyId=]` · `GET /campaigns/:id` | List with links; one campaign with its platform ids                         |
| `PUT /campaigns/:id/platforms/zeus`                  | The Zeus ids: `{ campaignId, idType, pixels?, creatives? }`                 |
| `PUT /campaigns/:id/platforms/nexd`                  | The NEXD ids: `{ creatives: [{ liveId }] }`                                 |
| `DELETE /campaigns/:id/platforms/:platform`          | Takes the platform off the campaign                                         |
| `GET /webhooks` · `POST /webhooks`                   | List (never a secret); create — the signing secret is in this response only |

A `PUT` is the whole id list for that platform. Adding ids always works. Changing or dropping one, or a `DELETE`, answers `409 platform_has_data` once that platform has written analytics for the campaign (the rows would stay attributed to the wrong ids), and `409 sync_in_progress` while a sync is fetching. Before that, the link is rebuilt from the request and its sync state forgotten. The headline source follows the ids: Zeus if the campaign has Zeus ids, otherwise NEXD, and Zeus while it has none. There is no create, edit or delete of a campaign by hand.

**Price** is what the client pays for 1000 impressions, up to four decimals, currency as an ISO 4217 code; `NULL` when the report has none, never 0.

A new platform needs one preset in `src/modules/campaigns/presets.ts`; another CRM needs one adapter that builds a `CampaignSetup`. Neither touches the service.

## Client report webhooks

A webhook is a row in `app.webhook`, created with `POST /webhooks`: the client's HTTPS endpoint, a
signing secret we generate and show once, a cron expression with a timezone, and which campaigns it
covers. A minutely tick enqueues the period
that has closed, builds the body in Postgres, signs the timestamp and the exact bytes it sends and
POSTs them; one `app.webhook_delivery` row per (webhook, period) is the idempotency record and its id
is the `X-Delivery-Id` header. Failures retry at 1 min, 5 min, 30 min, 2 h and 12 h, six attempts in
all.

**What it delivers** can be narrowed per webhook with a field list (`fields` on `POST /webhooks` or
`PATCH /webhooks/:id`): which metrics, which lists, and calculated fields written as formulas, e.g.
`{ "name": "cost", "formula": "impressions / 1000 * price", "source": "zeus" }`. Formulas are parsed,
never evaluated as code, checked against what their source measures before they are saved, and
computed exactly at every level of the report (`src/modules/webhooks/fields.ts`, `formula.ts`).

```sh
# the body a delivery of this period would carry; stores and sends nothing
curl -X POST http://127.0.0.1:3000/webhooks/<webhook id>/preview \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"period_start": "2026-09-07", "period_end": "2026-09-13"}'

# an out-of-schedule delivery, e.g. to test a new endpoint
curl -X POST http://127.0.0.1:3000/webhooks/<webhook id>/send-now \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"period_start": "2026-09-07", "period_end": "2026-09-13"}'
```

The body a client receives, and the rules for reading its numbers, are documented for them in
`docs/WEBHOOK-PAYLOAD-v1.md`. Setting one up from scratch is `docs/RUNBOOK.md` §2–3.

## CI/CD

GitHub Actions, in `.github/workflows/`:

- **`ci.yml`**, on every pull request to `main`: the migration guard (`check:migrations` against the base), `typecheck`, `lint`, unit tests, `build` + `build:smoke`, `npm audit --audit-level=high`, and the integration tests against a Postgres-only local Supabase stack that applies every migration from zero plus `seed.sql`. It needs no secrets.
- **`deploy-staging.yml`**, on every push to `main`: runs `ci.yml` on the merged commit, applies new migrations to the staging database (`supabase db push`, never the seed), deploys that commit through Render's deploy hook, and waits until `/healthz` reports it. Render's own auto-deploy is off, so code never starts before its migration.
- **Dependabot** opens weekly grouped updates for npm and the actions.

Setup, secrets and rollback are in `docs/RUNBOOK.md` §10.

## Branches

`main` is staging: it changes through pull requests only, and every merge deploys. Production comes later from a `release` branch that `main` is merged into once staging is tested; it is not set up yet. Each build step lands on its own feature branch with a green `typecheck`, `lint` and `test`.
