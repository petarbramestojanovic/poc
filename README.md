# analytics-be

Phase 1 of the standalone analytics product for playable-ad campaigns. Some creatives are served by third-party ad platforms that own the analytics: **NEXD** and **Zeus** (the adserver behind our ATK tracking pixels). This service pulls those numbers into our own Postgres nightly and on demand, stores them as day-replaced rows per source (never summed across sources), and pushes a signed, versioned JSON report to each client's HTTPS endpoint on a per-client schedule. It is one Node service on Render plus one Supabase Postgres project; there is no UI in phase 1, operators use the CLI.

Design of record: [RFC-004](docs/RFC-004-phase1-database-schema.md) (schema), [RFC-003](docs/RFC-003-external-analytics-adapter.md) (connectors and sync), [RFC-002](docs/RFC-002-standalone-analytics-app-supabase.md) (platform), and the [phase 1 plan](docs/PHASE1-PLAN-PROMPT.md). Working rules for contributors and coding agents: [CLAUDE.md](CLAUDE.md).

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

## Scripts

| Script                     | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run dev`              | Run `src/index.ts` on Node with `--watch`, loading `.env`         |
| `npm run build`            | Clean `dist/`, compile `src/`, copy the `sql/` directories        |
| `npm run build:smoke`      | Import the built modules, proving every `.sql` file was copied    |
| `npm start`                | Run the compiled service with source maps (`dist/index.js`)       |
| `npm run typecheck`        | `tsc --noEmit` over `src/`, `tests/` and config files             |
| `npm run lint`             | ESLint (type-aware) + Prettier check                              |
| `npm run lint:fix`         | Same, applying fixes                                              |
| `npm test`                 | Unit tests (Vitest project `unit`, no database needed)            |
| `npm run test:integration` | Integration tests against the local Supabase Postgres             |
| `npm run test:all`         | Both Vitest projects                                              |
| `npm run db:reset`         | `supabase db reset`: recreate the local DB from migrations + seed |

## Environment variables

See [.env.example](.env.example). Secrets live only in environment variables (locally in `.env`, on Render in the dashboard). `external.credential` rows store the _name_ of the variable, never the value.

| Variable              | Purpose                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Postgres URL: local direct; on Render the session pooler (5432) or direct, never the transaction pooler (6543) |
| `DATABASE_SSL`        | `verify-full` (default) or `disable` (loopback hosts only)                                                     |
| `DATABASE_SSL_CA`     | PEM of the database CA; empty uses the system CAs                                                              |
| `NEXD_API_KEY`        | NEXD bearer key                                                                                                |
| `ZEUS_API_TOKEN`      | Zeus bearer token                                                                                              |
| `SERVICE_ADMIN_TOKEN` | Bearer token for `/sync/*` and `/webhooks/*` routes, at least 32 characters                                    |
| `PORT`                | HTTP port                                                                                                      |
| `LOG_LEVEL`           | pino level                                                                                                     |
| `TRUST_PROXY_HOPS`    | Reverse proxies in front: 0 locally, 1 on Render, 2 with Cloudflare                                            |
| `TZ`                  | Always `UTC`; sources and schedules carry explicit timezones                                                   |

## Branches

`main` is the dev environment, `prod` is production; both change through pull requests only. Each build step lands on its own feature branch with a green `typecheck`, `lint` and `test`.
