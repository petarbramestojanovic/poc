-- 0008_webhook_rows.sql — how a webhook delivers its rows, the key the client's endpoint wants,
-- and manual re-sends of a period already delivered.
--
-- CHANGES TO RFC-004 TABLES, approved by the product owner on 2026-10-10. RFC-004 §4 defines
-- app.webhook without these columns and app.webhook_delivery with UNIQUE (webhook_id, period_start,
-- period_end); docs/RFC-004 is kept verbatim, so this header is the record of the deviation. The
-- second part is not additive: it replaces that constraint, as approved.
--
-- 1. app.webhook
--
--   format       what a delivery is (src/modules/webhooks/, docs/WEBHOOK-PAYLOAD-v2.md):
--                  json  the rows in a signed JSON body, POSTed to url
--                  csv   the rows as a CSV file this service serves at a signed, expiring link;
--                        the link is POSTed to url (Funnel's File Import webhook)
--   auth_header  the header the client's endpoint authenticates with, lowercase, e.g.
--                'x-funnel-fileimport-token' or 'authorization'
--   auth_token   its value, entered once by a Brame admin. The second secret this service keeps
--                in the database, after app.webhook.secret: it is never listed, logged, previewed
--                or granted (0006 grants nothing on app.webhook), and the API cannot read it back
--
-- Both auth columns are set together or not at all. Since 0008 the body is version 2, flat rows
-- (payload_version = 2): app.build_webhook_payload, include_check_sources and include_creatives
-- stay in place but are no longer read by the service.

ALTER TABLE app.webhook
  ADD COLUMN format      text NOT NULL DEFAULT 'json',
  ADD COLUMN auth_header text,
  ADD COLUMN auth_token  text,
  ADD CONSTRAINT webhook_format
    CHECK (format IN ('json', 'csv')),
  ADD CONSTRAINT webhook_auth_pair
    CHECK ((auth_header IS NULL) = (auth_token IS NULL)),
  ADD CONSTRAINT webhook_auth_header_name
    CHECK (auth_header ~ '^[a-z0-9-]{1,64}$');

COMMENT ON COLUMN app.webhook.format      IS 'json = rows POSTed as signed JSON; csv = a signed link to a CSV file POSTed (Funnel).';
COMMENT ON COLUMN app.webhook.auth_header IS 'Header the client endpoint authenticates with (lowercase); NULL = none.';
COMMENT ON COLUMN app.webhook.auth_token  IS 'Value of auth_header. Secret: never listed, logged or granted.';

-- 2. app.webhook_delivery: one SCHEDULED delivery per (webhook, period), any number of manual ones.
--
-- The schedule still sends a period exactly once: its insert conflicts on the partial index below
-- and does nothing (src/modules/webhooks/sql/insert_delivery.sql), and a re-queue never changes a
-- row's trigger, so a scheduled row keeps guarding its period. A person may send a period that was
-- already delivered again (send-now): that is a new row with a new id, so a client deduping on
-- X-Delivery-Id still takes it, and the record of the earlier delivery stays as it was. A period
-- whose latest delivery is pending or failed is still re-queued under that delivery's own id.
--
-- The plain index replaces what the unique constraint indexed: the webhook_id foreign key, and the
-- latest delivery of a period (load_delivery_for_period.sql).

ALTER TABLE app.webhook_delivery
  DROP CONSTRAINT webhook_delivery_webhook_id_period_start_period_end_key;

CREATE UNIQUE INDEX webhook_delivery_scheduled_period
  ON app.webhook_delivery (webhook_id, period_start, period_end)
  WHERE trigger = 'schedule';

CREATE INDEX webhook_delivery_period
  ON app.webhook_delivery (webhook_id, period_start, period_end, created_at DESC);
