# RFC: Standalone Analytics Platform — Review Summary

- **Status**: For review · **Author**: Petar Stojanovic · **Date**: 01.09.2026

---

## 1. What we are building

Replace the iframed jQuery/FusionCharts panel and the AWS stack behind it with a product we own end-to-end: companies, users, campaigns and analytics in one place, no Brame parent app.

**Two constraints drive every decision:**

1. **20–50M API calls/month** from unauthenticated ad units, spiky and concentrated on a few hot campaigns.
2. **Zero data loss** — no analytics event may be dropped due to traffic.

We are free to choose any stack. The case for moving is cost and simplicity: the application is essentially read/write with little custom logic, and per-request AWS pricing at this volume costs roughly double for a stack we have to assemble ourselves.


---

## 2. Architecture

```
  Playable ads in                         Company users
  end-user browsers                       (dashboard / admin)
  (20–50M req/mo, spiky)                          │
        │                                         │ login + view/manage
        │ POST /play, /report_impression,         │
        │      /analytics, /cta_link, ...         ▼
        ▼                              ┌──────────────────────────────┐
 ┌─────────────────────────┐          │  React + TypeScript SPA       │
 │  Cloudflare              │          │  (Cloudflare Pages)           │
 │  (rate-limit / WAF /     │          └───────────────┬───────────────┘
 │   DDoS / TLS)            │                          │ supabase-js
 └───────────┬─────────────┘                          │ (.select / .rpc),
             ▼                                         │ auth token attached
 ┌────────────────────────────┐                       │
 │  INGESTION SERVICE          │                       │
 │  Node.js + TypeScript       │                       │
 │  always-on, 2+ instances    │                       │
 │  on Render (EU/Frankfurt)   │                       │
 │  - connection pool (pg)     │                       │
 │  - atomic upserts           │                       │
 │  - unique-user HLL counters │                       │
 │  - signed-token check       │                       │
 │  ─────────────────────────  │                       │
 │  sync module                │──►  api.nexd.com      │
 │  - nightly 04:00 Zurich     │──►  t.zeus.ad         │
 │  - Salesforce ~15 min       │──►  Salesforce API    │
 │    (one instance holds the  │                       │
 │     leader lock)            │                       │
 │  - POST /sync/... on demand │                       │
 │  ─────────────────────────  │                       │
 │  webhooks module            │──►  client report     │
 │  - minutely due-check tick  │     endpoints (HTTPS  │
 │    (same leader lock)       │     POST, HMAC-signed)│
 │  - retries + delivery log   │                       │
 └───────────┬─────────────────┘                       │
             │ pooled SQL (upserts, day replace, COPY)  │
             ▼                                          ▼
 ┌────────────────────────────────────────────────────────────────┐
 │              SUPABASE — Zürich region (eu-central-2)             │
 │  PostgreSQL  +  Auth  +  Row-Level Security  +  Storage          │
 │  (managed: scaling, pooling/Supavisor, backups, patching, TLS)   │
 │                                                                  │
 │   schema "app"        companies, users, campaigns, audit_log     │
 │   schema "analytics"  advanced_analytics, ad_impressions,        │
 │                       page_views, cta_clicks, utm_*, ...         │
 │   schema "external"   source, campaign_link, event_map, sync_run │
 │   SQL functions       get_engagement_stats(), get_cta_*() ...    │
 └────────────────────────────────────────────────────────────────┘
```

| Path | Route | Why |
|---|---|---|
| **Public writes** | ad → Cloudflare → ingestion service → Postgres | Never ad → Supabase directly; the pool and the edge are what make it survive spikes |
| **Dashboard reads** | React → Supabase directly | No backend code for reads; Row-Level Security does the authorization |
| **Inbound pulls** | sync module → third-party API → Postgres | Nightly and on demand; runs inside the ingestion service |
| **Scheduled report pushes** | webhooks module → client's HTTPS endpoint | Per-client configurable schedule (e.g. Mondays 08:00); signed, retried, logged |

---

## 3. Stack

| Layer | Choice |
|---|---|
| Database | Supabase Postgres, **Zürich region** (Swiss data residency for DACH publishers) |
| Auth | Supabase Auth (email + password) — replaces Cognito and the hand-rolled authorizer. 2FA supported out of the box (authenticator app), enabled without custom code |
| Authorization | **Row-Level Security** — company scoping enforced in the database, not in handler code |
| Dashboard API | Supabase auto-API + Postgres functions via `.rpc()` — no backend for reads |
| Backend | Node.js + TypeScript on **Render** (EU/Frankfurt), always-on, 2–4 instances |
| Frontend | Vite + React + TypeScript + TanStack Query on Cloudflare Pages |
| Edge | Cloudflare — rate limiting, WAF, DDoS, TLS |

---

## 4. The four rules that shape the data model

These are the parts worth your scrutiny — each is cheap now and expensive to retrofit.

**1. Atomic upserts with unique constraints.** Every counter write becomes one race-free statement (`INSERT ... ON CONFLICT ... DO UPDATE SET counter = counter + EXCLUDED.counter`). This eliminates the current read-then-write pattern, duplicate rows and lost updates in one move. The unique constraints these depend on **do not exist today** — adding them is the core correctness fix.

**2. `source` inside every unique key.** Our ingestion increments; external platforms *restate* history (yesterday's number can change next week), so their writes must replace a whole day. Two writers with opposite semantics cannot share a row. A `source` column defaulted to `'brame'` separates them. Adding this to a unique key later means rebuilding every constraint the upserts depend on — so it goes in the first migration.

**3. One primary source per campaign — never sum across sources.** **ATK (Zeus) is the main source**; NEXD and our own instrumentation are checks. Each campaign declares `primary_source` (**ATK / NEXD / Custom**); the dashboard headline shows only that source, and a source switcher opens a **full per-source view** of each of the others — every source gets its own UI, showing only the metrics that platform measures — plus a Compare overlay for the check ("our count vs the adserver's count" — the exact question account managers field today). Nothing is ever summed across sources: ATK and our own instrumentation count the *same* game start, so a sum silently double-reports. Accepted cost: an ATK/NEXD headline is complete through **yesterday** (nightly sync, plus "Sync now"); the Custom check series stays real-time.

**4. Field ownership, once Salesforce is master.** Salesforce owns campaign identity and commercial metadata; the app owns technical setup (campaign tag, language, page/CTA config, NEXD live IDs, ATK pixel mapping, clicktags). A sync overwrites Salesforce-owned fields and **never touches** app-owned ones — otherwise every sync wipes the operational config.

---

## 5. Where the data comes from

| Source | What it provides | Cadence |
|---|---|---|
| **Our own ingestion** | Everything for creatives carrying our instrumentation | Real-time |
| **NEXD** | Full analytics for NEXD-served creatives — impressions, viewable, engagement, dwell, per-page and per-CTA events | Nightly + on demand |
| **Zeus (ATK)** | Adserver delivery per campaign/creative/device, plus daily fire counts for our ATK pixels (`loadATK`) | Nightly + on demand |
| **Salesforce** | Campaigns — the system of record | ~15 min + on demand |

Of the three analytics sources, each campaign declares **one as its primary** (§4, rule 3) — ATK by default — and the other two render as checks; Salesforce carries metadata, not analytics.

**On NEXD and Zeus:** each needs a **connector** — a small component that pulls that platform's numbers from its API and writes them into our database. Without the NEXD connector, NEXD-served campaigns are simply blank in our dashboard (those creatives carry NEXD's tracking instead of ours); without the Zeus connector, the ATK numbers — most campaigns' primary source (§4, rule 3) — never arrive, and comparing the adserver's counts with our own stays a manual job.

**On Salesforce:** campaigns are managed commercially in Salesforce, so it is the system of record for campaign metadata and the app becomes a replica of it rather than the place campaigns are authored. The sync is **one-way, Salesforce → app** (we never write back), every ~15 minutes plus on demand. A campaign created in Salesforce appears in the app automatically; operations then completes the technical setup in the admin UI — campaign tag, language, pixel mapping, clicktags — which are the app-owned fields of §4, rule 4, and are never touched by a later sync. Our UUID stays the primary key that creatives, analytics rows and RLS reference; the Salesforce ID is stored as a unique external key. A deleted or merged Salesforce record archives the campaign — it never deletes analytics.

---

## 6. Zero-loss, concretely

Three cheap layers, not one mechanism:

1. **Durable write** — a Postgres `COMMIT` is on disk. Once the upsert returns, the count cannot be lost.
2. **Connection pool absorbs spikes** — a burst is multiplexed onto ~10 connections per instance; under overload the service *queues* (latency rises) rather than failing writes. Postgres never sees a connection storm.
3. **Client-side retry** in the creative closes the last gap. Atomic upserts are safe to retry.

Batching is designed for but **not built** — a seam to enable if a single campaign ever sustains ~2–3k writes/sec on one row.

Separately: **backups are not what protect individual writes.** Supabase Pro's daily backups cover the rarer whole-database loss; the trade-off is a ≤24h window in a catastrophe, which we accept for aggregated counters. PITR is deliberately not enabled.

The public path is unauthenticated by nature; a signed per-campaign token plus Cloudflare's WAF and rate-limiting is what keeps junk writes out.

---

## 7. Other decisions worth flagging

- **Scheduled client reports (webhooks)** — clients receive an analytics summary at an endpoint they provide, on a configurable schedule (e.g. Mondays 08:00, their timezone). Signed, retried until acknowledged, visible delivery log; payload follows the primary-source rule. Can ship after launch.
- **Data residency** — Supabase Zürich, Render Frankfurt, so data stays in CH/EU.
- **Testing** — Vitest across the stack, integration tests against a real local Postgres, **pgTAP tests asserting cross-tenant isolation** (the regression net for the authorization model), Playwright for critical journeys, k6 once before launch.
- **CI/CD** — GitHub Actions as the quality gate and migration runner; each platform deploys itself. Two environments (`dev`, `prod`), migrations gated behind a required reviewer on prod.
