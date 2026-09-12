# RFC-002: Standalone Analytics & Campaign Management App (Supabase + Node service)

- **Status**: Draft
- **Author**: Petar Stojanovic
- **Date**: 07.06.2026

---

## 1. Context & what changed from RFC-001

RFC-001 was written under the assumption that we keep the existing AWS stack — 32 public Lambdas on API Gateway, Aurora Postgres, Cognito for auth — and incrementally improve it.

That constraint is now lifted. **We are building the new product from scratch and are free to choose any technology and provider.** This RFC re-decides the stack from first principles, with three facts that drive every decision:

1. **Scale target: 20–50M API calls/month** from unauthenticated end-user ad units, concentrated on a **few hot campaigns at a time** (spiky, not evenly spread). Designed with headroom well past 50M.
2. **Zero data loss is a hard requirement.** No analytics event may be dropped due to traffic.
3. **Managed-platform-first.** Scaling, networking, pooling, deploys, patching, TLS, and backups are pushed onto managed platforms by default. We own application code; we do not own infrastructure operations.

### 1.1 Why we are moving off the RFC-001 plan

The case comes down to **cost and simplicity** — the app is simple, and AWS is overkill for it.

- **Cost.** Per-request pricing on AWS (API Gateway + Lambda duration + per-call Data API + Aurora running 24/7) runs roughly **$400–700/mo at 50M req/mo**. The Supabase + Render stack does the same job for **~$110–205/mo**, and the curve stays flat as traffic grows because nothing here is billed per-request. See §9.4 for the full comparison.
- **Simplicity.** The application is essentially read/write with little custom logic. Supabase bundles managed Postgres + Auth + Row-Level Security + Storage + an auto-generated API into one platform — exactly the pieces we would otherwise have to assemble and run ourselves on AWS (Cognito, Aurora, RDS Proxy, Lambda, API Gateway, Secrets Manager, S3, plus all the VPC/IAM/CloudFormation glue that holds it together). Render then runs the one small Node service we actually need to write, on `git push`, with none of that glue.

Atomic-upsert / unique-constraint / connection-pool improvements described later (§6.4, §6.5) are correctness fixes we would apply on either host — they are not the reason for the platform change, just work we do once regardless of where we run.

---

## 2. Goals

1. Replace the iframed jQuery/FusionCharts panel with a standalone React SPA we own.
2. Own companies, users, campaigns, and analytics end-to-end (drop the Brame parent app).
3. Authenticate company users (email + password) and authorize every dashboard read by company scope, with a Brame-internal **super-admin** role — enforced in the database, not hand-written in handlers.
4. Move campaign provisioning out of raw SQL into the app (form → API → DB).
5. Keep the public ingestion path **zero-loss** under spiky traffic to a few hot campaigns.
6. Support CSV export of large datasets (up to ~2M rows) without timeouts or memory blowups.
7. Minimize operational burden: managed scaling, deploys, backups, TLS, networking.

## 3. Non-Goals

- ~~Migrating historical analytics from the old Aurora DB. **We start fresh** (see §11). Old Aurora goes read-only and is decommissioned once its campaigns age out.~~ **Superseded — see §13:** we now backfill historical data from 2014 onward via a one-time batch import.
- Reworking the *shape* of the analytics data model. The pre-aggregated counter-rollup tables are a good design; we keep them, add the missing unique constraints, and fix the write pattern.

---

## 4. Architecture Overview

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
 │  sync module (§14)          │──►  api.nexd.com      │
 │  - nightly 04:00 Zurich     │──►  t.zeus.ad         │
 │    (one instance holds the  │                       │
 │     leader lock)            │                       │
 │  - POST /sync/... on demand │                       │
 │  ─────────────────────────  │                       │
 │  webhooks module (§15)      │──►  client report     │
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

**Four distinct paths, by design:**

- **Public writes** (the high-traffic, zero-loss-critical path) go **ad → Cloudflare → ingestion service → Supabase Postgres**. Never directly from the ad to Supabase.
- **Dashboard reads** go **React → Supabase directly** via `supabase-js`, protected by Auth + Row-Level Security. No custom backend involved in reads.
- **External-analytics pulls** (§14) go **sync module → third-party API → Supabase**, nightly and on demand. This runs *inside* the ingestion service rather than in a service of its own — see §14.1 for why that is safe here and what it costs.
- **Scheduled report pushes** (§15) go **webhooks module → client's HTTPS endpoint**, on each webhook's configured per-client schedule (config in `app.webhook`, history in `app.webhook_delivery`). Same placement decision as sync — a module inside the ingestion service, behind the same leader-lock pattern, with client-endpoint failures never affecting `/readyz`.

---

## 5. Technology Decisions (summary)

| Layer | Choice | Why (for *this* team & workload) |
|---|---|---|
| Database | **Supabase Postgres, Zürich region (`eu-central-2`)** | Managed Postgres; durable by default (zero-loss); relational fit for campaign metadata; native `SUM/GROUP BY` and `COPY` export. Drops *Aurora*, keeps *Postgres*. **Zürich region pinned** for a Swiss-HQ company serving DACH publishers — keeps data in Switzerland by default. |
| Auth | **Supabase Auth** | Replaces Cognito + the JWT-authorizer + hand-rolled `authorize()`. Email/password out of the box. |
| Authorization | **Row-Level Security (RLS)** | Company-scoping enforced in the DB, not in handler code. Can't be forgotten in a handler. |
| Dashboard data API | **Supabase auto-API (`.from().select()`) + Postgres functions (`.rpc()`)** | No backend code for reads. |
| External analytics | **A sync module inside the ingestion service**, pulling NEXD + Zeus/ATK | Third-party platforms own the analytics for some creatives (§14). Nightly + on-demand pulls. No second deployable: the workload is tiny and almost entirely I/O wait, so it does not earn its own service (§14.1). Design in [RFC-003](./RFC-003-external-analytics-adapter.md). |
| Ingestion backend | **Node.js + TypeScript, always-on, on Render** | Connection pool survives spikes (zero-loss); reuses existing JS logic; one language across the stack; PaaS covers scaling/deploys/TLS/networking. Render chosen for **predictable fixed pricing** + an **EU (Frankfurt) region** next to Supabase. Railway/Fly are drop-in alternatives (the service is a portable Node app). |
| Frontend | **Vite + React + TypeScript + TanStack Query**, on **Cloudflare Pages** | RFC-001's frontend choice stands. Static hosting, near-free. |
| Edge protection | **Cloudflare** in front of ingestion | Rate-limiting, WAF, DDoS, TLS for the public path. |

Rejected: **Redis as the analytics store** (in-memory-first, conflicts with zero-loss; still need Postgres anyway — Redis stays a future option for rate-limiting and caching only). **Staying on AWS / Lambda** (materially more expensive at this traffic — see §9.4 — and forces us to assemble a multi-service stack for an application this simple, where Supabase + Render gives the same result with one platform and one small service).

---

## 6. Backend — the ingestion service

This is the only custom backend we write. It is small and focused: accept public writes, run game logic, write to Postgres durably, and serve large CSV exports. Everything else (auth, dashboard reads, permissions, storage) is Supabase.

### 6.1 Language, runtime, hosting

- **Node.js 20+ with TypeScript.** Same language as the frontend; first-class Supabase/`pg` support.
- **Hosting: Render** (managed container PaaS). Chosen over Railway/Fly for **predictable fixed pricing** (no usage-based bill creep) and an **EU/Frankfurt region** co-located with Supabase's EU database (low latency + EU data residency). Render provides autoscaling, auto-restart, rolling deploys, HTTPS, cron jobs, and metrics with no server management. Railway and Fly.io remain drop-in alternatives if needed — the service is a standard, portable Node app.
- **No VPC/IAM wiring** — the service reaches Supabase over a standard pooled Postgres connection string held as a platform secret (env var).

**Instance sizing & autoscaling (production):**

| Setting | Value | Why |
|---|---|---|
| Instance type | **Render Standard** (2 GB RAM, 1 CPU) | Service is I/O-bound (mostly waiting on Postgres), so memory/CPU usage is small. Standard gives comfortable headroom for spikes and Node's GC overhead. (Starter $7 is likely also sufficient — start there and bump if metrics show pressure.) |
| Min instances | **2** | One keeps serving while the other is restarted/redeployed (HA); also absorbs small spikes before the autoscaler reacts. |
| Max instances | **4** | Caps cost and total DB connections. 20–50M req/mo never needs more. |
| Scale-up trigger | CPU > **70%** sustained for **60 s** | Adds an instance before the existing ones saturate. |
| Scale-down trigger | CPU < **30%** for **5 min** | Slow scale-in prevents flapping. |
| `pg.Pool` size per instance | **`max: 10`** | At max 4 instances × 10 = 40 connections — safely under Supavisor's per-tier ceiling, with headroom for occasional bursts. (See §6.3 — this overrides the earlier illustrative `max: 20`.) |
| Health check | `GET /readyz` (200 = ready, anything else = remove from rotation) | Defined in §6.9. |

**Dev environment:** a single instance is enough (no HA required for non-prod). Use 1 × Render Starter ($7/mo).

### 6.2 Project layout

```
ingestion-service/
  src/
    index.ts            # HTTP server bootstrap (Fastify or Express)
    db.ts               # pg.Pool, single query() helper, COPY helper
    auth.ts             # signed transaction-token verification
    rateLimit.ts        # (optional) token-bucket; Cloudflare does the heavy lifting
    routes/
      play.ts           # /play, /play_finished  (engagement counters)
      analytics.ts      # /analytics  (advanced_analytics + page_views upserts)
      impression.ts     # /report_impression  (ad_impressions upsert)
      cta.ts            # /cta_link
      utm.ts            # /report_utm_parameters
      answers.ts        # /calculate_answer_percentage
      info.ts           # /get-info  (per-campaign config for the creative)
      export.ts         # /export-csv  (COPY streaming)
      sync.ts           # POST /sync/links/:id/run  (admin-authenticated, §14.1)
    upserts.ts          # the atomic upsert SQL builders
    batcher.ts          # (future) in-memory increment batching; off by default
    sync/               # external analytics (§14) — RFC-003 owns the internals
      scheduler.ts      #   nightly 04:00 Zurich, behind the leader lock
      engine.ts         #   runSync(linkId, window, trigger)
      connectors/       #   nexd.ts, zeus.ts
    webhooks/           # scheduled client report webhooks (§15)
      scheduler.ts      #   minutely due-check tick, behind the same leader-lock pattern
      deliver.ts        #   payload assembly, HMAC signing, retries, delivery log
  package.json
  tsconfig.json
```

The sync code is a **module in this service, not a second deployable** (§14.1). It shares the pool and the types, and adds no new deploy target, env-var set, or health check.

### 6.3 Database access — one pool, one helper

A single `pg.Pool` per instance. The pool multiplexes all incoming requests onto a small, fixed set of connections — this is what makes the service survive spikes without exhausting Postgres.

```ts
// db.ts
import { Pool } from 'pg'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,   // Supabase pooled (Supavisor) connection string
  max: 10,                                       // see §6.1: 10 × max 4 instances = 40 — safely under Supavisor ceiling
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

export const query = (text: string, params?: unknown[]) => pool.query(text, params)
```

> **Connection-string note:** Supabase exposes a **pooled** connection endpoint (Supavisor) and a direct one. The ingestion service uses the **pooled** endpoint, so even our pool sits behind Supabase's pooler — two layers of safety against connection storms. Use the *direct* endpoint only for migrations.

### 6.4 The core fix — atomic upserts with unique constraints

Every counter write becomes a single, race-free, one-round-trip statement. This eliminates the read-then-write pattern, duplicate rows, and the lost-update bugs in one move, and halves-to-quarters the per-request DB cost/latency.

Example — `/report_impression`:

```ts
// upserts.ts
//
// All counter rollups bucket by date in our canonical timezone (Europe/Zurich) — never
// by Postgres' CURRENT_DATE (which uses the session TZ, usually UTC, and would put requests
// near midnight in Zürich into the "wrong day" row).
const TODAY_ZRH = `(now() AT TIME ZONE 'Europe/Zurich')::date`

export const upsertAdImpressions = (p: AdImpressionInput) => query(
  `INSERT INTO analytics.ad_impressions
     (campaign_id, campaign_tag, language, events_date,
      impressions_501, impressions_502, impressions_503, impressions_1001, impressions_1003)
   VALUES ($1,$2,$3,${TODAY_ZRH},$4,$5,$6,$7,$8)
   ON CONFLICT (campaign_id, campaign_tag, language, events_date)
   DO UPDATE SET
     impressions_501  = ad_impressions.impressions_501  + EXCLUDED.impressions_501,
     impressions_502  = ad_impressions.impressions_502  + EXCLUDED.impressions_502,
     impressions_503  = ad_impressions.impressions_503  + EXCLUDED.impressions_503,
     impressions_1001 = ad_impressions.impressions_1001 + EXCLUDED.impressions_1001,
     impressions_1003 = ad_impressions.impressions_1003 + EXCLUDED.impressions_1003`,
  [p.campaignId, p.campaignTag, p.language,
   p.i501, p.i502, p.i503, p.i1001, p.i1003]
)
```

> **Canonical timezone for bucketing: `Europe/Zurich`.** Every counter write that includes `events_date` uses the same expression. This is the single setting that prevents off-by-one drift in dashboards near midnight.

**Unique constraints to add** (these do not exist today — they are what make `ON CONFLICT` work):

| Table | Unique key for `ON CONFLICT` |
|---|---|
| `advanced_analytics` | `(campaign_id, campaign_tag, language, events_date)` |
| `ad_impressions` | `(campaign_id, campaign_tag, language, events_date)` |
| `page_views` | `(campaign_id, campaign_tag, page_id, language, events_date)` |
| `cta_clicks` | `(campaign_id, campaign_tag, cta_id, language, events_date)` |
| `answers_collection` | `(campaign_id, answers_formation)` |
| `utm_parameters_analytics` | see note below |

> **Every key above also carries `source`** — see §14. Each rollup table gets a `source text NOT NULL DEFAULT 'brame'` column *inside* the unique key, so our own incrementing writes and the sync module's day-replace writes can never land on the same row. Build this into the initial migration rather than retrofitting it: adding a column to a unique key later means dropping and rebuilding every constraint the `ON CONFLICT` clauses depend on.

> **`utm_parameters_analytics` caveat:** its natural key spans many nullable text columns (`referrer, utm_source, utm_medium, utm_content, utm_campaign, utm_term, utm_source_register, brame_1/2/3`) plus a day bucket. Postgres treats `NULL`s as distinct in unique indexes, which breaks `ON CONFLICT`. Fix: **normalize all those columns to `''` (not NULL)** on write — they already default to `''` — and create a unique index on `(campaign_id, day, <all utm columns>)` where `day = date(created_at)`. This keeps one row per distinct UTM combination per day, matching the existing read queries.

### 6.5 Zero-loss guarantees (end to end)

Three layers, each cheap, that together satisfy "no event lost due to traffic":

1. **Durable write.** A Postgres `COMMIT` is on disk (WAL). Once the upsert returns, the count cannot be lost.
2. **Connection pool absorbs spikes.** A burst of 1,000 req/s is multiplexed onto ~20 connections; under overload the service *queues* (latency rises) rather than failing writes. Postgres never sees a connection storm.
3. **Client-side retry.** The ad creative retries a failed ingestion POST (small bounded retry with jitter). This closes the only remaining gap — a transient blip mid-write — by re-sending rather than dropping. The atomic upserts are safe to retry because re-applying `+1` for a genuinely failed write is correct; for pure counters, a duplicate apply in the "write succeeded but response lost" edge case is also harmless (counts converge to truth at the bounded retry limit).

The ingestion endpoints respond **fast** (one upsert, then `200`) so the creative isn't blocked and Cloudflare/clients don't time out under load.

### 6.6 Spike headroom & future batching (designed for, not built)

At 50M/month with few hot campaigns, a single hot `(campaign, language, date)` row may take a few hundred upserts/sec during prime time — well within Postgres single-row capacity (~2,000–5,000/sec). **Plain atomic upserts are sufficient at this tier; batching is not built for v1.**

The `batcher.ts` seam is reserved for later: if any single campaign ever sustains ~2–3k req/s on one row, flip on in-memory batching — buffer `+1`s per key for 1–5s and flush one `+N` upsert. That collapses thousands of writes into one, raising the effective ceiling 100–1000× while staying near-real-time. With multiple instances each flushes its own `+N`; the atomic add merges them. No re-architecture required — only this module is enabled.

### 6.7 CSV export of large datasets (up to ~2M rows)

Use Postgres `COPY ... TO STDOUT WITH CSV` streamed straight to the HTTP response. Memory stays flat regardless of row count, and there is **no 15-minute timeout cliff** (unlike the current Lambda export, which is pinned at `timeout: 900, memorySize: 10240` — the symptom of buffering everything in memory).

```ts
// routes/export.ts
import { to as copyTo } from 'pg-copy-streams'

// `COPY (...) TO STDOUT` does not accept bind parameters, so we cannot pass campaignId
// directly. Two safe options: (a) materialize the filtered rows into a TEMP TABLE via
// a parameterized SELECT, then COPY from the temp table; or (b) validate campaignId as
// a strict UUID before splicing it into the COPY SQL.
//
// We use (a) — slightly more code, but no human in the loop can ever introduce a
// non-parameterized variant later.

export async function exportUtmRowsCsv(req, res) {
  const client = await pool.connect()
  try {
    res.setHeader('Content-Type', 'text/csv')
    const safeName = req.campaignId.replace(/[^a-zA-Z0-9-]/g, '')
    res.setHeader('Content-Disposition', `attachment; filename="utm-${safeName}.csv"`)

    await client.query('BEGIN')
    await client.query(
      `CREATE TEMP TABLE export_rows ON COMMIT DROP AS
         SELECT campaign_id, created_at, referrer, utm_source, utm_medium,
                utm_campaign, utm_content, utm_term, utm_params_count
         FROM analytics.utm_parameters_analytics
         WHERE campaign_id = $1
         ORDER BY created_at`,
      [req.campaignId]
    )
    const stream = client.query(copyTo(
      `COPY (SELECT * FROM export_rows) TO STDOUT WITH CSV HEADER`
    ))
    stream.pipe(res)
    await finished(stream)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
```

- **Format: CSV, not XLSX, at this size.** XLSX has a hard ceiling of 1,048,576 rows per sheet — 2M rows cannot fit. CSV has no row limit (opens in Excel fine).
- **2M rows** ≈ a 400 MB–1 GB file, produced by `COPY` in seconds to ~1 minute. Direct streaming is fine for v1.
- **Robust upgrade (if exports grow):** async export — generate in the background, upload to **Supabase Storage**, hand the user a download link (or email it). Avoids holding a connection open. Add only if needed.
- This export route is **gated**: the dashboard calls it with the user's Supabase auth token; the service verifies the token (and company scope) before running the query. (Alternatively, generate exports via a Postgres function + Supabase Storage entirely on the Supabase side; the COPY-through-the-service path is simpler and reuses the pool.)

### 6.8 Anti-abuse on the public path

The ingestion endpoints are unauthenticated by necessity (hit from end-user browsers). Protection:

- **Cloudflare** in front: per-IP rate-limiting, WAF rules, DDoS protection, bot mitigation, TLS. This is the primary line and needs no code.
- **Signed transaction token.** The creatives already send an `X-Transaction-Key` header (it's in the current CORS config). Make it a real short-lived signed token (HMAC over campaign_id + timestamp, secret held server-side) so requests can't be trivially forged or replayed. Keys never live in browser JS in plaintext — consistent with our standing rule that secrets stay server-side.
- **In-app token-bucket** (`rateLimit.ts`) as a cheap backstop; optional given Cloudflare.

### 6.9 Unique-user counting (client-side UUID + HyperLogLog)

The ingestion path counts a person as **one** across many impressions by having each creative self-assign a stable random identifier on first visit, store it in the browser, and send it with every analytics request. The server counts distinct identifiers compactly via HyperLogLog sketches in Postgres. With a stable per-browser ID, cross-day uniques are accurate (no daily salt drift), and the server never touches IP or user-agent as part of the identity.

**Mechanism — two pieces.**

#### (a) Client-generated UUID, stored in localStorage

On the first impression in a given browser, the creative generates a cryptographically random UUID, persists it in `localStorage`, and sends it with every subsequent analytics request:

```js
// In the playable ad's analytics bundle
function getOrCreateUserId() {
  let id = null
  try { id = localStorage.getItem('brame_uid') } catch { /* private mode etc. */ }
  if (!id) {
    id = crypto.randomUUID()
    try { localStorage.setItem('brame_uid', id) } catch {}
  }
  return id
}

const userId = getOrCreateUserId()

fetch(url_base + 'report_impression', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Transaction-Key': signedToken },
  body: JSON.stringify({ ...payload, user_id: userId })
})
```

- **Stable per browser, indefinitely.** Same browser → same UUID across sessions, days, and weeks, until the user clears their localStorage. This is what enables *accurate* cross-day unique counts.
- **`crypto.randomUUID()`** is cryptographically random — 122 bits of entropy, no collision risk in practice. No need to hash, derive from device attributes, or read IP/UA.
- **Server stores no IP, no user-agent, no canvas attribute as identity** — the only thing entering the HLL is the random UUID the browser self-assigned. The server can't derive a user's UUID from anything it independently sees.
- **Fallback** (private browsing / `localStorage` disabled): the `try`/`catch` falls through and a fresh UUID is generated each page load. Unique counts gracefully degrade to *per-session* uniques for that fraction of traffic — counters still work; cross-session linkage for that user is just not possible. Acceptable.
- **Reset path**: clearing `localStorage` makes the user look like a new visitor next time — the natural mechanism users already have for "forget me."

**Legal posture.** Storing an identifier in `localStorage` is "tracking" under GDPR / ePrivacy Article 5(3) — legally equivalent to a cookie. **Consent is required** and is collected via the Brame DPA / publisher-consent framework that already covers the production system's use of Snowplow (which also uses `localStorage`). This is documented in the RoPA (§7.7) as part of the Records of Processing Activities.

#### (b) HyperLogLog sketches in Postgres

Storing every UUID per (campaign, day) would mean millions of rows. Postgres' **`hll`** extension answers "how many distinct values have I seen?" in **~12 KB regardless of how many uniques** (1K or 1B), with ~1–2% error. Sketches can be **merged** across rows/days — and because the client UUID is stable across days, the merge gives a truly de-duplicated cross-period count.

```sql
CREATE EXTENSION IF NOT EXISTS hll;

ALTER TABLE analytics.advanced_analytics  ADD COLUMN unique_users hll;
ALTER TABLE analytics.ad_impressions      ADD COLUMN unique_viewers hll;
ALTER TABLE analytics.cta_clicks          ADD COLUMN unique_clickers hll;
ALTER TABLE analytics.page_views          ADD COLUMN unique_viewers hll;
-- (one HLL column per rollup whose uniques we want to count)
```

Write path — the atomic upsert (§6.4) gains one column:

```sql
INSERT INTO analytics.advanced_analytics
  (campaign_id, campaign_tag, language, events_date, impressions, unique_users)
VALUES ($1, $2, $3, TODAY_ZRH, 1, hll_add(hll_empty(), hll_hash_text($4)))
ON CONFLICT (campaign_id, campaign_tag, language, events_date)
DO UPDATE SET
  impressions  = advanced_analytics.impressions + 1,
  unique_users = hll_add(advanced_analytics.unique_users, hll_hash_text($4));
-- $4 = user_id from the request body (the client-generated UUID)
```

Read path:

```sql
SELECT
  campaign_id,
  SUM(impressions)                                  AS total_impressions,
  hll_cardinality(hll_union_agg(unique_users))      AS unique_users
FROM analytics.advanced_analytics
WHERE events_date BETWEEN $1 AND $2
GROUP BY campaign_id;
```

`hll_union_agg` merges per-day sketches across the date range. Since the same browser produces the same UUID every day, this gives a **genuinely de-duplicated** cross-day unique count — "uniques over the last 30 days" reports the real distinct-browsers number, not 30× repeaters.

**Properties & trade-offs:**

- **Accurate cross-day, cross-week, cross-month uniques** (within HLL's ~1–2% error). Same browser, same UUID, counted once across any time window.
- **Server never holds IP or UA as identity.** The HLL is opaque — it cannot be reversed to recover individual UUIDs, only counted. Even with full DB access, you cannot enumerate users.
- **Scale-safe.** Constant ~12 KB/row regardless of traffic — same upsert shape as every other counter, no new round-trip.
- **Same browser = one user, even if multiple humans share it.** Family device, shared workstation: counts as one. Trade-off accepted for engagement analytics.
- **Different browser / cleared localStorage / private mode = new user.** Inherent to client-side identifiers; same limitation Google Analytics, Plausible, and Snowplow have.
- **Consent is required** at the publisher / DPA layer (Article 5(3) ePrivacy) — see §7.7. This is **not** a design that avoids the consent question; it's a design that gives accurate uniques *given* consent.
- **HLL approximate (~1–2% error).** Fine for engagement dashboards; do not use HLL for billing/legal counts where exact numbers are needed.

---

## 7. Database, Auth & Authorization (Supabase)

### 7.1 Schemas

- `app` — new product tables: `company`, `user`, `campaign`, `audit_log` (largely as RFC-001 §5.2, minus the Cognito-specific columns; `app.user` links to `auth.users` via the Supabase auth user id instead of `cognito_sub`).
- `analytics` — the rollup model: `advanced_analytics`, `ad_impressions`, `page_views`, `cta_clicks`, `utm_parameters_analytics`, `answers_collection`, plus `campaign_info` (per-campaign config served by `/get-info`). **All counter rollups have the unique constraints from §6.4** and start empty (fresh start). No end-user PII tables.
- `external` — the third-party sync bookkeeping (§14): `source`, `credential`, `campaign_link`, `link_entity`, `event_map`, `sync_state`, `sync_run`, `raw_payload`. Service-role only; admin screens reach it through `SECURITY DEFINER` functions with the same company scoping as everything else. Specified in [RFC-003](./RFC-003-external-analytics-adapter.md) §3.

When a campaign is created via the dashboard, the app writes `app.campaign` and seeds `analytics.campaign_info` (+ required setup rows) in **one transaction**; the legacy string `campaign_id` is the new `app.campaign.id` cast to text.

### 7.2 Auth

- **Supabase Auth**, email + password. Roles: `super_admin`, `company_admin`, `company_viewer`, stored on the `app.user` row and mirrored into the JWT via a custom claim (Supabase auth hook) so RLS can read it without an extra query.
- A trigger mirrors new `auth.users` into `app.user` (the Supabase equivalent of RFC-001's post-confirmation Lambda).
- Email delivery via Supabase's SMTP (configure a verified domain to avoid spam folders), or plug in SES/Resend.

### 7.3 Authorization via RLS (replaces the hand-rolled helper)

Company scoping is a policy, not handler code:

```sql
ALTER TABLE app.campaign ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaign_company_scope ON app.campaign
  FOR SELECT USING (
    (auth.jwt() ->> 'role') = 'super_admin'
    OR company_id = (auth.jwt() ->> 'company_id')::uuid
  );
```

The React app queries `app.campaign` directly via `supabase-js`; the database returns only the rows the logged-in user may see. Analytics reads go through **SQL functions** (`get_engagement_stats(...)`, `get_cta_analytics(...)`, etc.) that the dashboard calls with `supabase.rpc(...)`; each function checks the same scope.

### 7.4 Environments & migrations

**Two environments: `dev` and `prod`** — each is its own complete stack so dev work cannot touch production data.

| Environment | Supabase project | Render service | Branch | Purpose |
|---|---|---|---|---|
| `dev` | separate Pro project (cheaper compute) | 1 × Render Starter | `main` | Schema/RLS/feature work; safe to break and reset. Default branch — day-to-day PRs target it. |
| `prod` | the live Pro project (Zürich region) | 2–4 × Render Standard (§6.1) | `prod` | Production traffic. Promoted from `main` via a dedicated PR. |

> Why two **Pro** projects (not a free-tier dev project)? Free Supabase projects auto-pause after 1 week of inactivity, which kills the dev DX. $25/mo for a dedicated, always-on dev project is cheap insurance against that friction. Compute on dev stays on Micro (covered by the included $10 credit), so the real incremental cost is just the $25 base.

**Migration workflow** (plain SQL files via Supabase CLI, checked into the repo, applied via the **direct** Postgres connection — never the pooled one):

1. Author migration locally → push a PR targeting `main`.
2. CI runs migration against the `dev` project on the PR branch (or on merge to `main`); smoke-tests the schema and RLS contract.
3. Promotion PR: `main` → `prod` (review required).
4. On merge to `prod`, CI applies the migration against the `prod` project (with the manual-approval gate from §10.3).
5. **Rollback policy:** migrations must be authored as either (a) reversible (a paired `down` script) or (b) forward-only with an explicit annotation. Destructive forward-only migrations require a same-PR data backup script.

The ingestion service never runs migrations.

**Local development:** `supabase start` runs a full Supabase stack in Docker on the developer's machine (Postgres + Auth + Studio). Migrations apply locally first, so the dev project is itself the second integration target, not the first.

### 7.5 Data retention — 1-year purge

**Policy: data is removed from the database after 1 year.** Implemented entirely inside Postgres with the **`pg_cron`** extension — no backend code, no external scheduler, no operational glue. A nightly job deletes rows older than one year:

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'purge-old-analytics',
  '0 3 * * *',                      -- every night at 03:00
  $$
    DELETE FROM analytics.advanced_analytics      WHERE events_date < now() - interval '1 year';
    DELETE FROM analytics.ad_impressions          WHERE events_date < now() - interval '1 year';
    DELETE FROM analytics.page_views              WHERE events_date < now() - interval '1 year';
    DELETE FROM analytics.cta_clicks              WHERE events_date < now() - interval '1 year';
    DELETE FROM analytics.utm_parameters_analytics WHERE created_at  < now() - interval '1 year';
    DELETE FROM analytics.answers_collection      WHERE created_at  < now() - interval '1 year';
  $$
);
```

Implications:

- **Storage stays bounded and small.** We never hold more than ~1 year of (already tiny) counter data, so database storage stays comfortably within the included 8 GB indefinitely — this is why §9 lists storage at ≈ $0.
- **Dashboards are 1-year-bounded.** Analytics older than a year will not exist; the UI's date pickers should reflect this.

> **The purge as written above is unsafe once §13 and §14 land.** It would delete the entire 2014+ backfill on its first run, and it would delete synced external rows that the third-party API may no longer serve — an irreversible loss, since a platform's retention window is not ours to control (RFC-003 §6: connectors die, and *all synced history lives in our Postgres permanently*). The `DELETE`s must therefore be scoped to rows we can always recreate:
>
> ```sql
> DELETE FROM analytics.advanced_analytics
>  WHERE events_date < now() - interval '1 year'
>    AND source = 'brame' AND data_source = 'live';   -- same predicate on every table
> ```
>
> This makes the retention decision explicit rather than incidental: **live rows expire at 1 year; backfilled and externally-synced rows are kept.** The stakeholder decision flagged in §13.3 covers both classes and should be taken once, not twice.

### 7.6 Backups & disaster recovery

Two separate concerns, not to be conflated:

- **Durability (the zero-loss requirement)** is handled per-write: every upsert is committed to Postgres' WAL (on disk) the instant it returns, plus the pool + client retry (§6.5). Backups are *not* what protect individual writes.
- **Backups / DR** protect against the rarer case of the whole database being lost or corrupted.

**Decision: daily backups are sufficient.** Supabase **Pro includes automatic daily backups with 7-day retention** — no setup. The only trade-off is that a full restore-from-backup in a catastrophe rolls back to the last daily snapshot (up to ~24h of data). For aggregated ad counters under a 1-year retention, that disaster-window is acceptable. **PITR (point-in-time recovery) is therefore NOT enabled** — it stays a future dial (~$100/mo) only if a stakeholder later decides a 24h window is too large.

**Cheap insurance (recommended):** a periodic off-platform `pg_dump` (e.g. weekly to our own object storage) keeps a copy of the data fully in our control, mitigating provider-level risk independent of Supabase's own backups.

### 7.7 Data sovereignty & GDPR posture

Relevant because BMS is Swiss-HQ and sells into DACH publishers, where data handling is a trust signal. The GDPR distinction worth being explicit about:

- **Data residency** = where the bytes physically sit. Solved by **pinning the Supabase Zürich region (`eu-central-2`)** for the database (and Frankfurt for the Render backend — the closest EU region) so data and processing stay in Switzerland/EU end-to-end.
- **Data sovereignty** = whose law governs the provider. Supabase is a US-incorporated company (Delaware), so a Zürich region addresses residency but leaves a theoretical CLOUD Act exposure on personal data. This is a known, defensible posture — not a blocker — provided we document it correctly.

**Our posture (sufficient for the foreseeable future):**

1. **EU/Swiss regions pinned** across the stack: Supabase Zürich, Render Frankfurt, Cloudflare Pages (global CDN, EU edge serves EU users). No data leaves the EU/CH in normal operation.
2. **Data Processing Agreement (DPA) + Standard Contractual Clauses (SCCs)** signed with Supabase and Render — required GDPR paperwork; both providers offer them off the shelf.
3. **Records of Processing Activities (RoPA)** kept up to date — what personal data we hold, where, why, retention. With our model this is very short: only `app.user` (company-user credentials/profile). The analytics rollups hold no end-user personal data.
4. **Off-platform `pg_dump` insurance (§7.6)** kept inside our control, in an EU bucket.
5. **Unique-user counting uses a client-side UUID + HLL sketches** (§6.9): the creative stores a random UUID in `localStorage` and sends it with every analytics request; the server folds it into a non-reversible HLL sketch. **This is "tracking" under ePrivacy Article 5(3) and requires consent**, gathered via the Brame DPA / publisher-consent framework that already governs the production system's use of Snowplow `localStorage`. No IP or user-agent is stored server-side as identity; the HLL sketches cannot be reversed back to individual users.

**The escape hatch (if sovereignty ever becomes a deal condition):** the data is plain Postgres and the Node backend is a portable container, so a migration to a fully EU-sovereign stack — e.g. **Exoscale** or **Infomaniak** (Swiss-owned, Swiss-jurisdiction managed Postgres) for the database, with PostgREST/Hasura in front to replicate Supabase's auto-API — is a real, planned exit, not a vendor-lock-in trap. We pay no operational cost for it today; we only execute it if a major publisher makes it a requirement. This preserves the profitability-first stance while keeping the door open.

### 7.8 Campaign assets & static files (Supabase Storage)

All static files the creatives or backend need are kept in **Supabase Storage** (built into the Supabase project — same Zürich region as the database, no separate provider). This replaces the legacy S3 bucket entirely.

**What lives in Storage:**

| Bucket | Contents | Access |
|---|---|---|
| `campaign-config` | Per-campaign config JSON served by `/get-info` | Public read (creatives need it without auth); writes restricted to admin |
| `campaign-assets` | Images, logos, and any other static files referenced by the creative | Public read; admin write |
| `support-files` | Lookup lists, word lists, or other server-side files the backend may need | Service-role only (private bucket) |
| `exports` | Generated CSV exports parked for download (async-export upgrade path, §6.7) | Signed URLs scoped to the requesting company |

**How the backend reads them:**

- Public buckets are reachable via plain HTTPS URL — the backend can `fetch(...)` them with no auth. Supabase serves them through a built-in CDN, so reads are fast and cached at the edge.
- The `support-files` private bucket is read with the backend's service-role key over the Supabase client, never exposed to the browser.

**Why Storage, not a separate bucket on S3 / Cloudflare R2:**

- One platform, one Pro plan, one billing line; no extra account to administer.
- Same Zürich region → consistent data residency story (§7.7).
- Built-in CDN, signed URLs, RLS-aware permissions, no separate IAM setup.
- 100 GB of file storage and 250 GB of bandwidth are included in the Pro plan — far more than these buckets need.

**Upload flow:**

- Admin users upload files from the dashboard via `supabase-js` (`supabase.storage.from('campaign-assets').upload(...)`); RLS on Storage policies enforces "only company admins may upload to their own company's path."
- The path convention is `companyId/campaignId/...` so RLS can scope by the leading segment.

**Retention:**

- `campaign-config`, `campaign-assets`, `support-files` — kept while the campaign exists; deleted when the campaign is archived (admin operation).
- `exports` — auto-purged after 7 days by a `pg_cron` job calling `storage.delete_object(...)`.

---

## 8. Frontend (kept light — the easy part)

- **Vite + React + TypeScript + TanStack Query** (caching, loading/error states, refetch).
- **supabase-js** for auth + data: `.from().select()` for table reads (campaign list with search/filter/sort/pagination), `.rpc()` for analytics aggregations.
- **React Router**: `/login`, `/campaigns`, `/campaigns/:id`, `/admin/companies`, `/admin/users`.
- **Charts**: keep FusionCharts if licensed, else Recharts.
- **Testing**: Vitest + Testing Library + MSW (mock the supabase layer at the network boundary).
- **Hosting**: Cloudflare Pages (or Vercel). Static bundle, git-push deploys.

No bespoke API client, no token plumbing beyond supabase-js, no backend calls for reads — which is why the frontend is straightforward relative to the ingestion service.

---

## 9. Pricing

All figures USD/month. **Key property of this stack:** nothing is billed per API request. Your 20–50M monthly requests hit the Render container and land in Postgres as queries; they never appear as a per-request line item. The bill is driven by **compute size + included quotas**, both of which are predictable and don't scale linearly with traffic.

### 9.1 Bottom-line totals

The two numbers that matter — production cost at two scale points, with and without a separate dev environment:

| Scenario | Production only | + Dev environment | Notes |
|---|---|---|---|
| **Launch (~20M req/mo)** | **~$95** | **~$127** | Supabase Micro (covered by credit), 2 × Render Standard, Cloudflare Pages free, paid WAF on |
| **Steady (~50M req/mo)** | **~$110 – $205** | **~$142 – $237** | Supabase compute bumps to Small/Medium; Render autoscales up to 4 × Standard during spikes |
| Cheaper variant (2 × Render Starter instead of Standard) | -$36 | -$36 | Try Starter first; bump if metrics show pressure |
| External analytics sync (§14) | **$0** | **$0** | Runs inside the ingestion service — no extra instance |
| If PITR is ever enabled | +$100 | +$100 | Currently NOT enabled (§7.6) |

Numbers below show the per-line detail. **Verify current Supabase compute prices on supabase.com/pricing before final budgeting** — they drift; pin a screenshot when finalizing.

### 9.2 Production line items

| Service | Item | Cost | Notes |
|---|---|---|---|
| **Supabase Pro (prod)** | Base plan | **$25** | No auto-pause; daily backups (7-day retention) |
| | Compute (Micro at launch → Small/Medium at steady) | **$0 – $60** | Micro covered by $10 included credit; bump as needed |
| | DB storage (8 GB included) | **~$0** | Counter rollups tiny; 1-year retention keeps it bounded |
| | Egress (250 GB included) | **~$0** | Small upsert responses + occasional CSV exports |
| | Auth MAUs (100k included) | **$0** | Only dashboard users count; end-users are anonymous |
| | File storage (100 GB included) | **~$0** | Campaign assets in Supabase Storage (§7.8) |
| | PITR | **$0** | Not enabled |
| **Render (prod)** | 2 × Standard ($25 each) — see §6.1 sizing | **$50** | I/O-bound service; autoscale up to 4 × Standard during spikes (so peak = $100) |
| | External analytics sync (§14) | **$0** | A module inside the same service — no extra instance |
| **Cloudflare** | Pages (SPA hosting) | **$0** | Free tier is enough for a static SPA |
| | WAF / rate-limit / DDoS in front of ingestion | **$20** | Recommended at launch traffic levels (free tier rate-limit can be saturated by one misbehaving network) |
| | **Production subtotal at launch** | | **~$95** |
| | **Production subtotal at steady-state** | | **~$110 – $170** |

> Supabase compute add-on prices (approximate, verify on the pricing page): Micro ~$10, Small ~$15, Medium ~$60, Large ~$110. Compute is the one dial that scales with load — bump a tier when DB CPU pressure shows up, no re-architecture needed.

### 9.3 Dev environment add-on

A separate Supabase project and Render service for dev work — so dev cannot touch production data, and you can break/reset dev freely.

| Service | Item | Cost | Notes |
|---|---|---|---|
| **Supabase Pro (dev)** | Base plan | **$25** | Same Pro plan — using a free-tier project is tempting but it auto-pauses after 1 week of inactivity, which kills the dev DX |
| | Compute (Micro) | **$0** | Covered by the $10 included credit; dev never needs more |
| | Everything else | **$0** | Same quotas as prod, but dev traffic is negligible |
| **Render (dev)** | 1 × Starter (single instance — no HA needed for non-prod) | **$7** | Sufficient for dev/staging |
| **Cloudflare** | Pages preview deployments | **$0** | Built into the free tier |
| | **Dev subtotal** | | **~$32** |

### 9.4 Comparison to staying on AWS

At 50M/month, the current AWS pattern (per-request API Gateway + Lambda duration + per-call Data API) runs **~$350–450/mo plus Aurora** ($50–250/mo, paid 24/7 regardless of traffic). The Supabase + Render stack at the same scale is **~$110–205/mo** (production) — roughly half the cost, and the curve is **flat** as traffic grows (nothing here bills per-request).

### 9.5 What to watch (so there are no surprises)

- **Supabase compute add-on** is the only line that scales with load. Bump a tier when DB CPU pressure shows; this is a one-click change.
- **Render autoscaling** — capped at 4 × Standard (max **~$100** even under sustained peak). The cap prevents runaway cost.
- **Egress** — only matters if very large CSV exports become routine; counter-shaped traffic stays comfortably inside the 250 GB included.
- **External sync adds no line item** — it is bounded by the number of campaign links, not by ad traffic. The thing to watch is not cost but the pool: an operator running a long backfill during peak hours holds connections the ingestion path wants (§14.1 caps its share).
- **PITR & read replicas** — optional add-ons (~$100 each); enabled deliberately, not by default.
- Everything else (auth MAUs, storage, request count) stays comfortably within included limits.

---

## 10. Testing & CI/CD

### 10.1 Testing strategy

One test runner across the whole stack (**Vitest**), so frontend and backend share the same DX, the same matchers, and the same test commands. Specialized tools added only where they pay for themselves.

#### Frontend (React + TypeScript SPA)

| Layer | Tool | What it covers |
|---|---|---|
| Unit & component | **Vitest** + **@testing-library/react** + **@testing-library/user-event** | Components in isolation: rendering, props, user interactions, hooks. |
| DOM env | **happy-dom** | Faster than jsdom; sufficient for component tests. |
| Network mocking | **MSW (Mock Service Worker)** | Intercepts `supabase-js` calls at the network layer — gives realistic responses, works with TanStack Query without brittle module mocks. |
| End-to-end | **Playwright** | The three or four critical journeys: login → campaign list → campaign detail → see chart; CSV export download; super-admin view-as-company. Runs in Chromium + Firefox + WebKit. |

#### Backend (Node + TypeScript ingestion service)

| Layer | Tool | What it covers |
|---|---|---|
| Unit | **Vitest** | Pure functions: signed-token verify, request validation, UUID handling. |
| Integration | **Vitest** against **Supabase Local** (`supabase start`, Docker) | End-to-end through real Postgres: atomic upserts under concurrency, HLL counting accuracy, COPY streaming, `/healthz` + `/readyz` behavior. Fast (local Docker), realistic (real Postgres). |
| Database / RLS policies | **pgTAP** | SQL-level tests that **assert cross-tenant isolation** directly in the database: company A cannot SELECT/UPDATE/DELETE company B's rows; super-admin policy works as designed; service-role bypass works. This is the regression net for the GDPR-critical authorization model. |
| Load / spike | **k6** | Pre-launch only: replay a realistic hot-campaign spike (1–2 k req/s on one campaign for several minutes) against the dev environment. Pass thresholds: p95 latency < 200 ms, 0 failed writes, DB pool never saturates. |

**Coverage targets** (not hard gates, but tracked):

- **Backend critical paths** (upserts, signed-token, RLS, HLL writes): **≥ 80%**.
- **Frontend critical journeys** (login, RLS-scoped reads, export): covered by Playwright; component coverage **≥ 60%**.
- **RLS pgTAP suite**: **every policy** has at least one positive (allowed) and one negative (denied) test.

### 10.2 CI/CD pipelines (GitHub Actions)

Two pipelines, both in GitHub Actions. Each platform (Render, Cloudflare Pages, Supabase) handles its own deploy; Actions is the **quality gate and migration runner** in front.

#### Branch strategy

| Branch | Maps to | Deploy trigger |
|---|---|---|
| `main` (default branch) | **dev** environment | Auto-deploy on push (after PR checks pass) |
| `prod` | **prod** environment | Auto-deploy on push (after PR checks **and** manual approval, §10.3) |
| Feature branches | Preview environments | Cloudflare Pages auto-creates a preview URL per PR; Render preview environments (optional) per PR |

#### PR pipeline (runs on every pull request)

```yaml
# .github/workflows/pr.yml
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck            # tsc --noEmit
      - run: npm run lint                  # eslint
      - run: npm test                      # vitest (unit + integration)
      - run: npm run build                 # vite build / tsc build
      - run: npm audit --audit-level=high  # supply-chain check
  rls-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase start                # local Postgres + Auth in Docker
      - run: supabase db reset             # apply all migrations clean
      - run: pg_prove tests/rls/*.sql      # run pgTAP RLS suite
  e2e:
    runs-on: ubuntu-latest
    needs: check
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci && npx playwright install --with-deps
      - run: npm run test:e2e              # Playwright against Cloudflare Pages preview URL
```

This pipeline gates merges: a red check blocks the PR.

#### Deploy pipeline (on merge to `main` / `prod`)

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main, prod]
jobs:
  migrate:
    runs-on: ubuntu-latest
    environment:                                  # GitHub environment protection
      name: ${{ github.ref == 'refs/heads/prod' && 'prod' || 'dev' }}
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase db push                     # apply pending migrations
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL_DIRECT }}
  smoke:
    runs-on: ubuntu-latest
    needs: migrate
    steps:
      - run: curl -fsS $INGESTION_URL/healthz
      - run: curl -fsS $INGESTION_URL/readyz
      - run: npm run smoke                        # 1–2 happy-path checks against the deployed env
```

- **Render** auto-deploys the backend on push (the dev service watches `main`; the prod service watches `prod`).
- **Cloudflare Pages** auto-deploys the frontend the same way.
- **Migrations** are the one thing the platforms don't run — Actions does it, *before* the platform deploys land, so the schema is ready when the new code starts.

### 10.3 Migration deployment & environment protection

- **Dev migrations**: auto-applied by the `migrate` job above. Safe to break and re-reset.
- **Prod migrations**: the same job, but the `prod` GitHub environment has a **required-reviewer protection rule** — a maintainer must click "approve" in the Actions UI before the job runs. This is the manual gate for destructive migrations.
- **Destructive migration policy** (§7.4): drops / renames / not-null-on-populated-column / data-rewriting migrations require an `-- @destructive` comment header in the migration file. CI fails the PR if a migration has destructive DDL without that annotation.
- **Rollback**: each platform supports one-click revert to the previous deploy. For schema rollback, see §7.4 — migrations are authored reversible (`up`/`down`) or annotated forward-only with a same-PR data-backup script.

### 10.4 Secrets & quality gates

| Concern | Tool / mechanism |
|---|---|
| Runtime secrets (DB URL, signed-token HMAC) | **Render env vars** + **Cloudflare env vars** (dashboard) |
| CI secrets (Supabase DB URL for migrations, Render/Cloudflare API tokens) | **GitHub Encrypted Secrets**, scoped per environment (`dev` / `prod`) |
| Dependency updates | **Dependabot** — opens PRs for outdated deps; security advisories fail CI |
| Secret leaks in source | **GitHub native secret scanning** (built-in, free for public + Pro repos) |
| Supply-chain audit | `npm audit --audit-level=high` in the PR pipeline (fails on high/critical) |
| Lint / format | **ESLint** (TypeScript-aware ruleset) + **Prettier** |
| Type safety | **`tsc --noEmit`** in CI for both frontend and backend |

### 10.5 Branch protection — what blocks a merge

The CI pipeline reports check results to GitHub, but the gate that actually blocks a merge is configured in the repo's **branch protection rules** (Settings → Branches). Without it, a PR with red checks could still be merged. With it, the **Merge button is disabled** until every required check is green.

**Rules to enable on `prod` (the strict gate to production):**

| Rule | Setting |
|---|---|
| Require status checks to pass before merging | ✅ — and mark these as required: `check`, `rls-tests`, `e2e` |
| Require branches to be up to date before merging | ✅ — PR must be rebased on latest `prod` so checks reflect what actually merges |
| Require pull-request reviews | **≥ 1 reviewer** |
| Dismiss stale review approvals when new commits are pushed | ✅ |
| Restrict who can push to matching branches | ✅ — everything through PRs; no direct pushes / force-pushes |
| Include administrators | ✅ — rules apply to everyone, including admins |
| Require linear history | ✅ — keeps `prod` clean (no merge commits from the PR side) |

**Rules to enable on `main` (the default branch, dev environment — lighter to keep velocity):**

- Require status checks to pass before merging ✅
- Required checks: same as `prod` (`check`, `rls-tests`, `e2e`)
- Pull-request reviews: optional

**Promotion to production** is a dedicated PR `main` → `prod`. It reuses the same required checks, plus the reviewer + admin-bound rules above, so prod releases are deliberate and reviewed.

**What "fails" means concretely:** any job in the PR workflow that exits non-zero — a failing unit test, a `tsc` type error, a lint violation, `npm audit` finding a high-severity advisory, a **pgTAP cross-tenant test letting company B read company A**, a Playwright E2E click that breaks — turns its check red. While *any* required check is red, the **Merge** button reads "*Required statuses must pass*" and is disabled. Push a fix → checks re-run → button re-enables when they go green.

**Edge cases worth knowing:**

- **Flaky/stuck required checks**: an admin can override the gate (the override is recorded in the audit log; we treat it as a near-miss to investigate, not a normal pathway).
- **Dependabot PRs**: subject to the same checks; nothing special.
- **Draft PRs**: the checks run, but the PR is unmergeable until marked "Ready for review."
- **`prod` after a green merge**: the same checks run again on `prod` via the `deploy` workflow; a broken `prod` blocks the auto-deploy until fixed (so red tests never reach production).
- **Hotfixes**: a critical prod issue can be PR'd straight to `prod` (without going via `main` first) — same checks, same review gate, just a shorter path. Cherry-pick back to `main` after.

The practical effect: **broken code cannot reach `prod`** — not by accident, not by haste, not even by an admin without leaving a trace.

### 10.6 What this gives us in one sentence

Every PR is type-checked, linted, unit/integration-tested against a real local Postgres, cross-tenant-checked via pgTAP, and E2E-tested against a real preview URL — and every merge auto-deploys to dev or (with one approval click) to prod, with migrations applied as a separate gated step that fails loud if anything is wrong.

---

## 11. Migration / Phasing (clean-slate)

| Phase | Outcome |
|---|---|
| **1. Supabase foundation** | Create project. Port the `app` + `analytics` schemas **with the §6.4 unique constraints**, starting empty. Configure Auth + RLS policies + the role claim hook. |
| **2. Ingestion service** | Node/TS service on Render (EU/Frankfurt): pooled `pg`, atomic upserts for all public endpoints, HLL columns + client-UUID intake, signed-token check, Cloudflare in front. Point a test creative at it. |
| **3. Dashboard reads** | Analytics SQL functions (`get_*`) + RLS-scoped table reads. CSV export route via `COPY`. |
| **4. React SPA** | Vite/React/TS + supabase-js + TanStack Query on Cloudflare Pages. Login → campaign list → campaign detail → analytics. |
| **5. Provisioning** | Campaign creation through the app (form → transaction). New campaigns live only in the new system. |
| **6. Cutover** | Production creatives point at the new ingestion endpoints. Old Aurora goes **read-only** for legacy lookups; decommission once its campaigns age out. |
| **6b. External sync** | `external` schema + the `sync/` module in the ingestion service + NEXD and Zeus/ATK connectors (§14, RFC-003). Depends only on the schema from Phase 1, so it can run in parallel with Phases 3–5 or land after cutover. |
| **7. Polish** | Audit-log surfacing, super-admin "view as company", paid WAF rules, alerts, async CSV export if needed. |

Note: Phase 2 (the ingestion service + atomic-upsert rewrite) delivers the zero-loss correctness independently and could even be applied to the *current* infra if we ever needed an interim fix — but the plan is to build it directly against Supabase.

---

## 12. Estimations (one developer, full-time)

Effort estimates for **one experienced full-stack developer** (Node/TypeScript + React + working Postgres knowledge, picks up Supabase/Render quickly) working full-time on the project, with no parallel contributors. Units are **working days**.

Every step below includes writing the tests for the code it produces — there is no separate "testing phase" at the end. The test infrastructure itself (Vitest configs, GitHub Actions, branch protection, Supabase Local for integration, Playwright base, pgTAP scaffolding) is the **first** step so it can be set up early and amortised across every later step. The cost of catching a regression at PR time is always lower than catching it in production.

### 12.1 Step-by-step estimates

| # | Step | Scope (incl. tests for the code produced) | Days |
|---|---|---|---|
| **1** | Setup projects | GitHub repository (with `main` + `prod` branches, team access). **Supabase projects: dev + prod, Zürich region.** **Render services: dev + prod**, watching `main` / `prod` respectively. **Cloudflare account** + domain added. Connect GitHub → Render (auto-deploy on push). Connect GitHub → Cloudflare Pages. Local dev environment (Supabase CLI, Node 20, package managers). Initial repo scaffolding (folder structure, `package.json`, `.gitignore`, basic README). | **5** |
| **2** | Test infrastructure & CI/CD | Vitest configs (FE + BE). Supabase Local (`supabase start`) for integration. pgTAP scaffolding. Playwright base. GitHub Actions `pr.yml` + `deploy.yml`. Branch protection on `prod` + `main` (§10.5). Dependabot + secret scanning. Set up **early** so every later step's tests run in CI from day one. | **5** |
| **3** | Supabase foundation | Schema migrations for `app` + `analytics` (with §6.4 unique constraints). RLS policies + the JWT role-claim hook. Auth (email/password, password policy, post-confirmation trigger to `app.user`). `pg_cron` retention. Storage buckets + RLS. **pgTAP positive + negative tests for every RLS policy.** | **5** |
| **4** | Ingestion service | Node/TS + Fastify scaffold. `pg.Pool` + `db.ts`. Atomic upsert helpers per rollup table (§6.4). All public endpoints (`/play`, `/play_finished`, `/analytics`, `/report_impression`, `/cta_link`, `/report_utm_parameters`, `/calculate_answer_percentage`, `/get-info`). Signed-token verification. CSV export via `COPY`. `/healthz` + `/readyz`. HLL columns + client-UUID intake. Structured logs. **Vitest unit + integration suite against Supabase Local; k6 load test covering hot-campaign spike.** | **12** |
| **5** | Dashboard SQL functions | Port the ~18 legacy read endpoints (`get_engagement_stats`, `get_cta_*`, `get_page_view_*`, `get_brame_{1,2,3}_stats`, `get_utm_*`, `get_referrer_stats`, `get_conversion_stats`, etc.) as Postgres functions exposed via `supabase.rpc()`. **pgTAP tests for each function's RLS contract.** | **5** |
| **6** | React SPA | Vite/React/TS scaffold. supabase-js + TanStack Query + React Router. Login, password reset, session handling. Campaign list (search/filter/sort/pagination from §5.3). Campaign detail page with every analytics panel as a chart. Admin pages (companies, users, role management). CSV export trigger UI. Loading/error/empty states. Responsive layout. Cloudflare Pages deploy. **Vitest component tests + Playwright E2E for 3–4 critical journeys (login → campaign list → detail → chart; CSV export; super-admin view).** | **15** |
| **7** | Campaign provisioning | Admin form (validation, incl. the required `primary_source` pick from §14.3; transaction writing `app.campaign` + seeding `analytics.campaign_info`). Asset upload UI (Supabase Storage with the path convention from §7.8). **Component + integration tests for the transaction.** | **2** |
| **8** | Cloudflare setup | DNS records, Cloudflare Pages config, free-tier WAF + rate-limit rule on ingestion endpoints, signed-token rotation procedure documented. | **5** |
| **8b** | External analytics sync (§14) | `sync/` module in the ingestion service: scheduler + leader lock, on-demand trigger endpoint + auth, capped pool share. `external` schema. NEXD connector + mapper. Zeus/ATK connector + mapper + pixel mapping. `source` handling + `primary_source` resolution in the read functions (§14.3). Admin UI: links, pixel mapping, "Sync now" + run status. **Fixture-based mapper tests + a `--dry-run` diff against the existing NEXD script as the acceptance test.** Detailed breakdown in RFC-003 §7. | **23** |
| **9** | Documentation & polish | Internal runbook (deploy, rollback, secret rotation, restore-from-backup drill). RoPA. README. Short architecture doc for future hires. Audit-log surfacing in dashboard. Super-admin "view as company" mode. | **3** |
| **10** | Buffer for unknowns | Render/Supabase edge cases. Anything the RFC didn't predict. | **10** |

### 12.2 Totals

| | Value |
|---|---|
| **Working days** — core product (steps 1–10, excluding 8b) | **67** |
| **Working days** — with external sync (step 8b) and the §13 backfill (+4) | **94** |
| **Working weeks** (at 5 days/week) | **~13.5** core · **~19** full |
| **Calendar time** (with ~10–15% off for sick days, public holidays, slack) | **~15 weeks** core · **~21 weeks** full |
| **In months** | **~3.5 months** core · **~5 months** full |

**Practical sense check:** plan for **~3.5 months calendar time** for a single full-time developer to take the core product from an empty repo to production launch, and **~5 months** to also have the historical backfill and both external connectors live. The split is deliberate — the external sync (step 8b) and the backfill (§13) both depend only on the schema being right at step 3, so they can ship after launch without rework, or be handed to a second developer to run in parallel.

---

## 13. Historical data backfill (2014 → cutover) — *supersedes the fresh-start decision in §3/§11*

**Decision change:** we do migrate history after all. All analytics data from **2014 onward** is imported into the new Supabase database so historical campaigns remain queryable in the new dashboard.

### 13.1 The two-database problem, and why it isn't one

The legacy data lives in two places:

- **Production DB** — where campaigns are created: campaign/company metadata (names, tags, languages, config).
- **Aurora DB** — where the analytics rollups live: `advanced_analytics`, `ad_impressions`, `page_views`, `cta_clicks`, `utm_parameters_analytics`, `answers_collection`.

The key insight: **we never need a live link between the two.** This is a one-time batch import, not a sync. We snapshot each database independently to files, and the join between "campaign metadata" and "analytics rows" happens offline in the loader script — keyed on the string `campaign_id` both systems already share.

### 13.2 Approach — one-time batch ETL, then one delta pass

1. **Snapshot both sources to CSV.** `COPY (...) TO STDOUT WITH CSV` per relevant table, from each DB separately. No cross-DB connectivity, no VPC peering, no DMS — just two sets of export files. From the **production DB**: only the campaign table, filtered to **`is_tailor_made = true`** (plus the company rows those campaigns reference). From **Aurora**: all analytics rollup tables, filtered to `>= 2014-01-01`.
2. **Load everything into a throwaway `staging` schema** in the new Supabase DB (`COPY ... FROM` over the **direct** connection, not Supavisor), before production cutover so the target tables are otherwise quiet. From here the entire transform is **plain SQL** — no application code needed.
3. **Transform in SQL — `INSERT ... SELECT` from staging into the real tables.** Note the target stays **split**: campaign metadata → `app.campaign`, analytics rows → the `analytics.*` rollup tables, linked by `campaign_id` (the dashboard joins at query time; we do *not* denormalize into one flat table — §7's RLS policies and SQL functions are written against the split schema). The transform script:
   - loads staged production campaigns into `app.company` / `app.campaign`, producing `app.legacy_campaign_map (legacy_campaign_id text → campaign_id uuid)`; Aurora campaigns missing from the production export get stub `app.campaign` rows (flagged `is_legacy_stub`) so no analytics row is orphaned;
   - **collapses duplicates** — the legacy tables have no unique constraints (§6.4), so duplicate `(campaign, tag, language, date)` rows exist; `GROUP BY` the new unique key and `SUM` the counters, otherwise the insert violates the new constraints;
   - **normalizes** `utm_parameters_analytics` NULLs to `''` (the §6.4 caveat);
   - **stamps provenance** — every backfilled row gets `data_source = 'legacy_aurora'` (live writes default to `'live'`);
   - drops the `staging` schema when validation (step 5) signs off.
4. **Delta pass at cutover.** Legacy traffic keeps writing to Aurora until Phase 6 (§11). At cutover, re-export only rows for `events_date >=` the first snapshot date and re-run the loader in **replace mode** (delete-then-insert per key for legacy rows) — idempotent, so it can be re-run safely.
5. **Validate.** Per-campaign, per-year `SUM` comparisons between source exports and Supabase (impressions, plays, clicks) plus total row counts. Publish the comparison as a one-page sign-off sheet before decommissioning Aurora.

### 13.3 Consequences elsewhere in this RFC

- **§7.5 retention purge must be amended — this is the one real conflict.** The nightly 1-year purge would delete the entire backfill on its first run. Fix: the purge job adds `AND data_source = 'live'` (legacy rows are exempt), *or* the 1-year policy is revisited entirely now that we've decided history has value. **Decision needed from stakeholders; default: exempt legacy rows.** §14.2 raises the identical conflict for externally-synced rows — take the decision once, covering both classes.
- **Storage:** ~12 years of pre-aggregated counters is still small (rollup rows, not events) — expect low single-digit GB, within the included 8 GB. `utm_parameters_analytics` is the only table worth sizing before the import; if it alone is huge, it can be truncated to fewer years without losing the headline metrics.
- **No historical uniques:** HLL columns (§6.9) stay empty for backfilled rows — the client UUID didn't exist historically. Dashboards show unique-user metrics only from cutover onward; the UI should render "n/a" rather than 0 for legacy date ranges.
- **Date buckets are kept as-is.** Legacy rows were bucketed in the legacy system's timezone (likely UTC), new rows in Europe/Zurich (§6.4). A ±1-day edge on historical midnight traffic is accepted — not worth re-deriving.
- **Effort:** add **~4 days** to §12 (loader script + mapping + validation + delta pass), plus the stakeholder decision on retention.
- **§11 Phase 6** gains a sub-step: run the delta pass and validation *before* Aurora goes read-only-then-decommissioned.

---

## 14. External analytics sources (NEXD + Zeus/ATK)

Not all of our numbers are ours to count. Two third-party platforms hold analytics for creatives we ship, and the dashboard is incomplete without them:

| Source | What it holds | Why it can't be ignored |
|---|---|---|
| **NEXD** | Everything for NEXD-served creatives — impressions, viewable, engagement, dwell, per-page and per-CTA events | Those creatives ship `nexd.sendEvent` **instead of** our own instrumentation, so without this connector the campaign is simply blank in our dashboard |
| **Zeus** (`https://t.zeus.ad/api/doc`) | Adserver delivery per campaign / creative / device, plus daily fire counts for the **ATK** pixels our creatives already call via `loadATK(...)` | ATK is each campaign's default primary source (§14.3), and the ATK counts are what the customer already sees in Zeus's own UI — reconciling them with ours by hand is a recurring account-management cost today |

**The design lives in [RFC-003](./RFC-003-external-analytics-adapter.md)**, which specifies the connector interface, the canonical row shape, both connectors, the `external` schema, and the scheduling. This section records only what the decision changes *inside this RFC*.

### 14.1 Fetching: nightly, and on demand — inside the ingestion service

Both triggers run behind one function in a **`sync/` module of the ingestion service** (§6.2): a nightly run at **04:00 Europe/Zurich** over every active link, and a per-link **"Sync now"** button on the campaign page, authenticated with the caller's Supabase token and company-scoped exactly like `/export-csv` (§6.7).

**Why not its own service.** The obvious objection is that this puts batch work in the service that must never drop a write (§6.5). It does not earn a second deployable, because the workload is *tiny*: tens of campaign links, one to three HTTP calls each, a few KB of JSON per link for a 7-day window. It is almost entirely I/O wait; the parsing that actually occupies the event loop is single-digit milliseconds, and the nightly run happens at 04:00 when there is no spike to contend with. A separate service would cost a second deploy target, env-var set, and health check to isolate a load we can measure in kilobytes. We have exactly one NEXD credential and one Zeus credential — both our own company accounts — so there is no growing pile of third-party secrets to keep out of the public-facing process either.

**Three things this makes our responsibility.** They are cheap, but skipping any of them turns a saving into a bug:

1. **A leader lock on the schedule.** The service runs 2–4 autoscaled instances (§6.1), so an in-process scheduler fires on *every* instance — 04:00 becomes 2–4 simultaneous runs. Correctness is already covered (RFC-003 §4's per-link advisory lock serialises them, and day-replaces are idempotent), but it would multiply our third-party API calls on rate limits we have not been told yet. The nightly job therefore takes a single `pg_try_advisory_lock` first and exits immediately if another instance holds it.
2. **A capped share of the pool.** Sync work never takes more than **3 of the 10** connections per instance (§6.3), so a long operator backfill cannot starve the ingestion path.
3. **Sync failures must not affect readiness.** A third-party API being down is not this service being unhealthy. `/readyz` (§6.9) reflects the pool and the ingestion path only; sync health is visible in `external.sync_run`, not in the load-balancer's rotation.

**Revisit if any of that stops being true** — a platform whose sync takes minutes of CPU, or a credential set that grows per client — at which point the module lifts out into its own Render service unchanged, since it is already a self-contained folder with one entry point.

**Neither trigger produces live data, and the UI must not imply otherwise.** Zeus's API is explicit that the newest available day is *yesterday*, and NEXD restates completed days on an undocumented schedule. "Sync now" re-pulls **completed** days (7 by default); it never surfaces today's traffic. Label the control accordingly and show `last_synced_at` beside it.

### 14.2 What this changes in the schema — decide now, not later

Three changes are cheap in the initial migration and expensive to retrofit:

1. **`source` inside every rollup's unique key** (§6.4). Our ingestion writes `counter = counter + 1`; external sources *restate* history, so a sync must overwrite a whole day. Two writers with opposite semantics cannot share a row. Adding this column to a unique key after the fact means dropping and rebuilding every constraint the `ON CONFLICT` upserts depend on — do it in the first migration, defaulted to `'brame'`, and the ingestion service never notices.
2. **The retention purge must not delete what it cannot recreate** (§7.5). External history is ours permanently — a platform's own retention window is not under our control, and connectors do get shut off. The purge is scoped to `source = 'brame' AND data_source = 'live'`.
3. **Platform-reported uniques are scalars, not HLL.** `unique_impressions` / `unique_clicks` from Zeus and NEXD land in `unique_users_reported`, never in the `hll` columns from §6.9: they are pre-aggregated per day and cannot be merged across a date range. The read layer must never `SUM()` them, and the UI must show "—" rather than a wrong total for a multi-day range on an external source.

### 14.3 Which number is *the* number: a primary source per campaign

NEXD and Zeus stand in genuinely different relationships to our own data — NEXD measures traffic nothing else measures, while the ATK pixel fires on the *same* interaction that already calls our own `gameStarted()`. Summing across sources therefore either under- or double-counts depending on the pair, and does it silently, in the flattering direction.

The resolution is a ranking, not arithmetic: **ATK (Zeus) is the main source; NEXD and our own instrumentation are checks.** Each campaign declares it:

- **`app.campaign.primary_source`** — `'zeus'` (ATK) / `'nexd'` / `'brame'` (shown as *Custom* in the UI). It is an FK into the `external.source` registry rather than a Postgres enum, so a fourth source is a seed row instead of a migration (RFC-003 §6; `'brame'` is seeded as a pseudo-source row).
- **The dashboard headline is the primary source's rows only; nothing is ever summed across sources.** The other sources sit behind a source switcher and a Compare view as labelled check series — "our count vs the adserver's count" is exactly the question account managers field, and it currently requires opening two dashboards. A source with no data shows greyed out as "no data" rather than hidden; that too is a check result.
- **Defaults:** existing and backfilled campaigns are assigned once — `'zeus'` where an ATK link exists, else `'nexd'`, else `'brame'` (so §13's legacy campaigns look unchanged). New campaigns pick at provisioning — required, with a warning when the chosen primary has no configured link.
- **The freshness trade-off is accepted:** a `'zeus'`/`'nexd'` primary is complete through yesterday (§14.1), so the headline carries `data_complete_through` and "Sync now" covers urgency; the `'brame'` check series stays real-time.

Mechanics — the column DDL, read-function resolution, and the assignment pass — live in RFC-003 §4.1, which this model supersedes in its earlier `combine_mode` (additive/parallel) form.

### 14.4 Secrets

**Two credentials in total** — one NEXD API key and one Zeus token, both our own company accounts, covering every client campaign. This is what makes §14.1's single-service decision comfortable: there is no per-client secret set accumulating inside the internet-facing process.

They never live in the database. `external.credential` holds a *pointer* (env-var name) plus the platform's account scope; the values are Render env vars, consistent with §10.4 and with our standing rule that third-party API calls are backend-mediated. The `account_scope` column stays regardless — it costs nothing, and it is the seam that absorbs a second account later without a migration (RFC-003 §3.1).

### 14.5 Open, and worth resolving early

The blocking unknown is which field of Zeus's `/reports/tracker` response carries our ATK identity — the spec documents neither the `checksum` nor the `creativeId` format, so the pixel-to-campaign mapping cannot be written from the spec alone. It is resolved by one discovery call against a real token, and RFC-003 §2.3 keeps the connector working under any of the three plausible answers. The full list of questions for both platforms is RFC-003 §7.

---

## 15. Scheduled client report webhooks

Clients should not have to log into the dashboard to get their numbers. A company admin configures a **webhook**: a client-provided HTTPS endpoint that receives an analytics summary on a recurring schedule — the canonical example is *every Monday at 08:00*, but both the day and the time are configurable per webhook, in the client's timezone.

### 15.1 Where it runs — a `webhooks/` module in the ingestion service

Same decision, same reasoning as the sync module (§14.1): this is a tiny, I/O-bound batch workload — tens of webhooks, one HTTP POST each, firing at most a handful of times per day — and it does not earn a second deployable. It lives in `webhooks/` (§6.2), shares the pool (under the same capped share as sync — batch work never takes more than 3 of the 10 connections), and its failures never touch `/readyz`: a client's endpoint being down is not this service being unhealthy.

**Why not `pg_cron`, which already runs the retention purge (§7.5)?** The purge is one static, database-internal job — exactly what `pg_cron` is for. Webhooks are the opposite on every axis: the schedules are **dynamic per-row config** (creating a cron job per webhook from application code is unmanageable and unobservable), the work is an **outbound HTTP call** (possible from Postgres via `pg_net`, but then HMAC signing, timeouts, retry backoff, and delivery logging all become SQL problems), and the payload is assembled from a dozen SQL functions. Application code is the right altitude; the database only stores the config and the delivery log.

### 15.2 Scheduling model — one tick, not N timers

The scheduler does **not** hold a timer per webhook. A single **minutely tick** (behind the same `pg_try_advisory_lock` leader-lock pattern as §14.1's nightly run — 2–4 instances, exactly one fires) selects due rows and delivers them:

```sql
SELECT * FROM app.webhook
 WHERE enabled AND next_run_at <= now()
 FOR UPDATE SKIP LOCKED;
```

Each webhook stores a `schedule_cron` expression plus an IANA `timezone` (e.g. `0 8 * * 1` + `Europe/Zurich` = Mondays 08:00 Zurich time). After a delivery attempt is enqueued, `next_run_at` is recomputed with a timezone-aware cron library (`cron-parser`), which is what makes DST transitions correct — "08:00 Zurich" stays 08:00 through both clock changes. The admin UI does not expose raw cron: it offers *daily / weekly (pick weekday) / monthly (pick day)* plus a time and timezone, and writes the cron string. Because dispatch is `next_run_at`-driven, a missed tick (deploy, restart) is caught by the next one — the row is still due — rather than lost.

### 15.3 Schema and config

Two tables in `app`, company-scoped by the same RLS pattern as everything else in §7.3:

```sql
CREATE TABLE app.webhook (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company,
  campaign_ids   uuid[],                    -- NULL = all of the company's campaigns
  url            text NOT NULL,             -- https:// enforced by CHECK + app validation
  secret         text NOT NULL,             -- HMAC signing secret, generated by us (§15.5)
  schedule_cron  text NOT NULL,
  timezone       text NOT NULL DEFAULT 'Europe/Zurich',
  report_window  text NOT NULL DEFAULT 'previous_week',  -- previous_day | previous_week | previous_month
  enabled        boolean NOT NULL DEFAULT true,
  next_run_at    timestamptz NOT NULL,
  created_by     uuid REFERENCES app.user
);

CREATE TABLE app.webhook_delivery (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id    uuid NOT NULL REFERENCES app.webhook,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL,              -- pending | delivered | failed
  attempts      int  NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  response_code int,
  payload       jsonb NOT NULL              -- exact payload sent, for audit + resend
);
```

Config CRUD needs **no backend route** — the admin UI writes `app.webhook` directly via `supabase-js` under RLS, like every other dashboard write. The one backend route is `POST /webhooks/:id/send-now` (admin-authenticated and company-scoped exactly like `/export-csv` and `/sync/...`), which fires an immediate out-of-schedule delivery for testing and for re-sends.

### 15.4 Payload and delivery semantics

The payload is a **versioned JSON document** assembled from the same Postgres functions the dashboard reads (§12 step 5): per campaign in scope, the headline metrics for the report window (impressions, plays, completions, CTA clicks, …), with `period_start` / `period_end` explicit. The §14.3 rule carries over verbatim: the headline figures are the campaign's **`primary_source`** only, with other sources as their own labelled series (included or not per webhook config) — a pushed report must not sum across sources any more than the dashboard may.

Delivery is **at-least-once**:

- One `webhook_delivery` row per (webhook, period) — the row is the idempotency record, and its id is sent as an `X-Delivery-Id` header so a client receiving a retry can dedupe.
- 10 s timeout; only a 2xx response counts as delivered.
- On failure: retries with exponential backoff (~1 min, 5 min, 30 min, 2 h, 12 h — five attempts), driven by the same minutely tick re-selecting failed-but-retryable rows. After the last attempt the row is marked `failed` and surfaces in the admin UI next to a **"Resend"** button; nothing retries forever silently.

### 15.5 Security

- **HTTPS only**, validated at config time and enforced by a table `CHECK`.
- **HMAC-SHA256 signature** over the raw body with the per-webhook secret, sent as `X-Signature` alongside an `X-Timestamp` (reject-replay window is the client's choice to enforce; we document it). The secret is generated by us at webhook creation and shown once in the UI.
- The secret lives **in the database, not in env vars** — a deliberate, bounded deviation from §14.4's rule. That rule keeps *third-party platform credentials* out of the DB; this is a per-row secret **we mint ourselves**, useless outside signing our own payloads, and per-client by nature (env vars cannot hold per-row config). RLS scopes it to the owning company; Supabase Vault is the upgrade path if column-level encryption is later wanted.
- **Egress guard:** the delivery client resolves the target host and refuses private/loopback/link-local addresses, so a webhook URL cannot be pointed at the service's own network (SSRF).

### 15.6 The completeness caveat — schedule after the sync

A Monday 08:00 report over the previous Mon–Sun is only complete if the externally-synced sources (§14) have already restated Sunday — and the nightly sync runs at **04:00 Europe/Zurich**. Two consequences:

1. The admin UI **warns** when a webhook whose campaigns include externally-sourced links is scheduled between midnight and ~05:00 local time, and suggests 06:00+.
2. The payload carries a per-source `data_complete_through` date, so a client's automation can see exactly what the numbers cover instead of guessing. This is the push-channel version of §14.1's "label the Sync-now button" rule: never let the delivery imply freshness the sources don't have.

### 15.7 Effort

Add **~4 days** to §12 (schema + RLS + pgTAP, scheduler tick + delivery/retry engine with Vitest coverage against a stub receiver, payload assembly reusing the step-5 functions, admin UI form + delivery-log page). It depends only on the schema (step 3) and the read functions (step 5), so — like 8b — it can ship after core launch without rework.

