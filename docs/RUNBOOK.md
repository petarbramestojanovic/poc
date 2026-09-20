# Runbook

Everything an operator or a new developer needs to run this service: from a clone to a delivered
test webhook, and then the day-to-day — adding a client, rotating a key, backfilling, reading what
happened, re-sending a report.

The design lives in [RFC-002](RFC-002-standalone-analytics-app-supabase.md),
[RFC-003](RFC-003-external-analytics-adapter.md) and [RFC-004](RFC-004-phase1-database-schema.md);
this file is only how to operate what they describe. The client-facing body is documented separately
in [WEBHOOK-PAYLOAD-v1.md](WEBHOOK-PAYLOAD-v1.md).

---

## 1. What runs

One Node service and one Postgres database. The service does three things:

|              | When                | Entry point                                |
| ------------ | ------------------- | ------------------------------------------ |
| Nightly sync | 04:00 Europe/Zurich | `startNightlyScheduler` → `runNightlyTick` |
| Webhook tick | every minute        | `startWebhookScheduler` → `runWebhookTick` |
| Admin routes | on request          | `/sync/*`, `/webhooks/*` (bearer token)    |

Both schedules run on every replica and both take a Postgres advisory lock first, so exactly one
replica does the work. The nightly pass holds lock key 1, the webhook tick key 2. The lock needs a
real session: a direct connection or Supabase's **session** pooler (port 5432). The transaction
pooler (6543) is refused at boot — under it the lock would silently mean nothing.

Health: `GET /healthz` is liveness (no database), `GET /readyz` is readiness (a database round
trip). A failing sync or a client's endpoint being down never makes the service unready.

---

## 2. From clone to a delivered test webhook

Prerequisites: Node 24 (`.nvmrc`), Docker, and a public HTTPS endpoint you control. A throwaway
endpoint from a service such as webhook.site works; **localhost does not** — the egress guard
refuses loopback and private addresses, deliberately.

```sh
npm ci
cp .env.example .env
npx supabase start          # local Postgres + Studio on 127.0.0.1:54323
npm run db:reset            # migrations + seed.sql
npm test                    # unit tests, no database
npm run test:integration    # against the local stack
```

`.env` needs `DATABASE_URL` (the direct URL `npx supabase status` prints), `DATABASE_SSL=disable`
and a `SERVICE_ADMIN_TOKEN` of at least 32 characters (`openssl rand -base64 32`).

Create a webhook for the seeded dev campaign, pointing at your endpoint:

```sql
INSERT INTO app.webhook (id, company_id, name, campaign_ids, url, secret, schedule_cron, timezone, next_run_at)
VALUES ('20000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
        'test endpoint',
        ARRAY['00000000-0000-4000-8000-000000000002'::uuid],  -- NULL = every campaign of the company
        '<https://your-endpoint>',
        '<a secret you generate: openssl rand -hex 32>',
        '0 8 * * 1', 'Europe/Zurich', now());
```

Give the campaign something to report — either sync real data (§4) or insert a couple of rows by
hand:

```sql
INSERT INTO analytics.advanced_analytics
  (campaign_id, source, language, campaign_tag, events_date, impressions, in_view, data_source)
VALUES ('00000000-0000-4000-8000-000000000002', 'zeus', 'de', 'mpu_v1', current_date - 2, 1000, 800, 'sync'),
       ('00000000-0000-4000-8000-000000000002', 'zeus', 'de', 'mpu_v1', current_date - 1, 2000, 1600, 'sync');
```

Then send it, with the service running (`npm run dev`). The period has to be one the rows fall in —
with the two rows above, yesterday and the day before:

```sh
curl -X POST http://127.0.0.1:3000/webhooks/20000000-0000-4000-8000-000000000001/send-now \
  -H 'authorization: Bearer <SERVICE_ADMIN_TOKEN>' -H 'content-type: application/json' \
  -d "{\"period_start\": \"$(date -d '2 days ago' +%F)\", \"period_end\": \"$(date -d yesterday +%F)\"}"
```

It answers `202 {"deliveryId": …}` and delivers in the background. Without a body it uses the
webhook's own report window (the previous whole week for `previous_week`). Check the row:

```sql
SELECT status, attempts, response_code, left(response_excerpt, 200), last_attempt_at, next_attempt_at
  FROM app.webhook_delivery WHERE id = '<deliveryId>';
```

`status = 'delivered'` with `response_code = 200` means your endpoint received it and answered 2xx.
Your endpoint should see `X-Delivery-Id`, `X-Timestamp` and `X-Signature`; verifying the signature
is described in [WEBHOOK-PAYLOAD-v1.md §1](WEBHOOK-PAYLOAD-v1.md).

To watch the schedule instead of sending by hand, set `WEBHOOK_SCHEDULER_ENABLED=true` in `.env`
and `next_run_at = now()`: the tick within the next minute enqueues the period and delivers it.

---

## 3. Adding a client

Phase 1 has no admin UI; setup is SQL, and the ids come from the platforms.

1. **Company and campaign.** `primary_source` is the platform whose numbers are the headline; every
   other source is shown beside it and never added to it.

   ```sql
   INSERT INTO app.company (id, name) VALUES ('<uuid>', '<client>');
   INSERT INTO app.campaign (id, company_id, name, primary_source, timezone, starts_on, ends_on)
   VALUES ('<uuid>', '<company uuid>', '<campaign>', 'zeus', 'Europe/Zurich', '<start>', '<end>');
   ```

2. **Pages and CTAs** the creative reports, before any sync writes to them:

   ```sql
   INSERT INTO analytics.cta (campaign_id, cta_id, name, is_internal_event, sort_order)
   VALUES ('<campaign uuid>', 'clickthrough', 'Click-out', false, 1);
   INSERT INTO analytics.page (campaign_id, page_id, name, sort_order)
   VALUES ('<campaign uuid>', 'main', 'Main', 1);
   ```

3. **A link per source and language**, then the external ids. The full statements, including the
   Zeus pixels and the NEXD event map, are in the README under
   "Sync against the real APIs locally" — they are the same for a real client.

4. **The webhook**, as in §2. Generate its secret with `openssl rand -hex 32`, store it in
   `app.webhook.secret`, and give the client the secret and
   [WEBHOOK-PAYLOAD-v1.md](WEBHOOK-PAYLOAD-v1.md). It is the one secret that lives in the database:
   we mint it, it signs only our own payloads, and it is per client, so an environment variable
   cannot hold it.

5. **Check it end to end** before telling the client: `--check-connection`, one `--dry-run` sync,
   one real sync, then `send-now` for a closed period.

---

## 4. Syncing

```sh
npm run sync -- --check-connection zeus-main                 # probe a credential, record the result
npm run sync -- --source zeus --list-pixels                  # what the token can see
npm run sync -- --link <link id> --dry-run                   # the source's lookback, nothing written
npm run sync -- --link <link id> --from 2026-09-01 --to 2026-09-07 --trigger backfill
npm run sync -- --all                                        # the nightly pass, right now
```

- Without `--from/--to` a run pulls the source's lookback ending yesterday (7 days; 35 on the
  Sunday deep pull) — restatements are the norm, so recent days are always re-pulled.
- `--trigger manual` (the default) is subject to the source's cooldown, `backfill` is not. Long
  windows belong to the CLI: the HTTP route caps a window at 366 days.
- A sync **replaces** every day in the window it covered, including days the platform now reports
  nothing for. It never adds to what is there, so running it twice is safe.

Over HTTP (same work, from a deploy or a script):

```sh
curl -X POST http://127.0.0.1:3000/sync/links/<link id>/run \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"from": "2026-09-01", "to": "2026-09-07"}'
curl http://127.0.0.1:3000/sync/runs/<run id> -H 'authorization: Bearer <token>'
```

`202` with the run id means the run is open; `409` means that link is already running or is
disabled, `429` means you are inside the cooldown, `422` means the link config is invalid.

---

## 5. Rotating a credential

Platform keys live only in environment variables; `external.credential.secret_env_var` holds the
**name** of the variable, never the value.

1. Get the new key from the platform and put it in the new environment (Render dashboard, or `.env`
   locally). Keep the old one until the new one is proven.
2. Deploy or restart, so the process reads it.
3. `npm run sync -- --check-connection <credential name>`. It records the outcome on the credential
   row; `ok: false` from a 429 or a 5xx means "cannot tell", not "wrong key" — try again.
4. Run one link, check `external.sync_run`, then remove the old key.

To point a credential at a differently named variable, update `secret_env_var` — it must keep the
shape the service enforces (`NEXD_API_KEY`, `ZEUS_API_TOKEN`, …) and can never name a variable the
service itself reads, such as `DATABASE_URL`.

**A webhook secret** rotates differently: it is one column, so generate a new one, update
`app.webhook.secret`, and tell the client at the same moment — there is no overlap window in phase 1.
Two active secrets would need a second column (RFC-004 change, not done).

---

## 6. Reading what happened

**A sync run**

```sql
SELECT r.id, c.name AS campaign, l.source_id, r.trigger, r.status,
       r.window_from, r.window_to, r.days_written, r.rows_written,
       r.started_at, r.finished_at, r.warnings, r.error
  FROM external.sync_run r
  JOIN external.campaign_link l ON l.id = r.link_id
  JOIN app.campaign c ON c.id = l.campaign_id
 ORDER BY r.started_at DESC
 LIMIT 20;
```

`warnings` is a JSON array of things worth knowing that did not stop the run — for example Zeus
reporting more unique clicks than clicks for a day, which is stored as reported and never clamped.
`error` is the redacted failure message of a failed run. The raw responses are in
`external.raw_payload` for that `sync_run_id`, with request parameters redacted.

**What a source has covered**

```sql
SELECT l.source_id, l.language, s.data_complete_through, s.last_synced_at, s.last_deep_sync_at
  FROM external.sync_state s
  JOIN external.campaign_link l ON l.id = s.link_id
 WHERE l.campaign_id = '<campaign uuid>';
```

**Deliveries**

```sql
SELECT d.id, w.name, d.period_start, d.period_end, d.trigger, d.status, d.attempts,
       d.response_code, left(d.response_excerpt, 200) AS excerpt, d.last_attempt_at, d.next_attempt_at
  FROM app.webhook_delivery d
  JOIN app.webhook w ON w.id = d.webhook_id
 ORDER BY d.created_at DESC
 LIMIT 20;
```

`payload` on the same row is the exact body that was sent, kept for audit and for re-sending.

**Unmapped events** (NEXD event names nothing maps to yet):

```sql
SELECT link_id, event_name, first_seen, last_seen, total_count
  FROM external.unmapped_event ORDER BY total_count DESC;
```

Add a row to `external.event_map` for each (`metric`, `page_view`, `cta_click` or `ignore`) and sync
the window again.

---

## 7. When a run fails

Read `external.sync_run.error` and `status` first, then match the `code`:

| What you see                                                  | What it means                                                                                                                                    | What to do                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `verification_failed`                                         | The platform's own numbers contradict each other: clicks above impressions, a total that does not match its rows                                 | Nothing was written for that day. Keep the run id, read `external.raw_payload`, and ask the platform. Never "fix" the numbers on our side. |
| `contract_violation`, `row_out_of_window`, `invalid_row_date` | The response had a shape we do not accept — a row for a campaign we did not ask about, a day outside the window we requested, an impossible date | Check the link's `external.link_entity` rows against the platform; a wrong external id is the usual cause.                                 |
| `upstream_http` / `upstream_network`                          | The platform failed or was unreachable                                                                                                           | Retryable. The next nightly pass covers the same days anyway; re-run the link if it is urgent.                                             |
| `too_soon`                                                    | Inside the manual cooldown                                                                                                                       | Wait, or use `--trigger backfill` for a real backfill.                                                                                     |
| `invalid_link_config`                                         | `external.campaign_link.config` does not match what the connector needs                                                                          | The error lists the field paths, never the values. Fix the row.                                                                            |
| `aborted`                                                     | A deploy or shutdown stopped the run between days                                                                                                | Nothing is half-written: days already committed stand, the rest is re-pulled next run.                                                     |

A failed run never moves the cursor: `external.sync_state` and the unmapped queue are committed only
after every day of that run was written.

---

## 8. Re-sending a report

```sh
curl -X POST http://127.0.0.1:3000/webhooks/<webhook id>/send-now \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"period_start": "2026-09-07", "period_end": "2026-09-13"}'
```

- A period whose delivery **failed** (or is still pending) is re-queued under the **same delivery
  id**, with a freshly built payload — the numbers may have moved since the failure.
- A period that was **delivered** answers `409 already_delivered`. That is deliberate: re-queueing
  would erase the delivered record. If the client genuinely lost it, resend by hand from
  `app.webhook_delivery.payload`, or clear the row knowing the audit trail goes with it.
- Retries of a failed delivery happen on their own: 1 min, 5 min, 30 min, 2 h after each failure,
  five attempts in all, then `status = 'failed'` and nothing retries silently.

What the client sees is in [WEBHOOK-PAYLOAD-v1.md](WEBHOOK-PAYLOAD-v1.md): `X-Delivery-Id`,
`X-Timestamp`, `X-Signature`, a 10 second timeout, and only a 2xx counting as delivered.

**A report that looks empty.** Check `data_complete_through` in the payload before suspecting the
delivery: a Monday 08:00 report over Mon–Sun is only complete if the nightly pass (04:00) has
already restated Sunday. Schedule client webhooks for 06:00 or later.

---

## 9. Logs and what is never in them

Structured pino JSON on stdout. Useful fields: `reqId` (per request), `syncRunId`, `linkId`,
`webhookId`, `deliveryId`, `component` (`nightly-scheduler`, `webhook-scheduler`).

Secrets are redacted by explicit path, and anything we persist — `sync_run.error`, a delivery's
`response_excerpt`, raw payloads — is redacted too, including URL query parameters. A presented
token is never logged, only the reason it was refused. If you add a log line carrying a new object
that could hold a secret, add its path to `src/log.ts` and a case to `tests/unit/log.test.ts`.

---

## 10. Deploying

Not automated in phase 1 (CI and the Render setup are steps 12 and 15–16). What a deploy must
respect:

- `DATABASE_URL` points at the session pooler (5432) or the direct connection, never 6543.
- `TZ=UTC` everywhere. Days and schedules carry their own explicit timezones.
- Migrations are additive and applied before the new code starts; never edit an applied migration.
- Shutdown: SIGTERM stops both schedules, drains in-flight runs and deliveries, then closes the
  pool, with a hard exit after 10 seconds. Render's 30-second window is enough.
