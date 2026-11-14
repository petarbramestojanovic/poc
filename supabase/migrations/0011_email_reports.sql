-- 0011_email_reports.sql — reports sent by email (src/modules/email-reports/).
--
-- ADDITIVE, approved by the product owner on 2026-11-14 (plan "Email Reports Plan", version 3):
-- two new tables in app. No RFC-004 table, column or key changes, and app.webhook /
-- app.webhook_delivery are untouched: an email report is its own record, with its own deliveries,
-- built by the same report code as a webhook (src/modules/webhooks/build.ts).
--
-- app.email_report         what is sent to whom and when
--   kind                   what the report is; one today: 'rows', the flat rows of a webhook (its
--                          settings: { format, fields }, the column list of src/modules/webhooks/
--                          fields.ts). A new kind adds its name to the CHECK in a later migration.
--   recipients             one email to all of them, 1–20 addresses, checked by the service
--   schedule_cron          when it is sent, in timezone; report_window which period it covers, as on
--                          app.webhook (previous_day = daily, …)
--
-- app.email_report_delivery  one email for one period: the idempotency record, as
--                          app.webhook_delivery is for webhooks. Its id is minted before the file is
--                          built; document is the exact attachment. The schedule makes one row per
--                          (report, period) (partial unique index); a person may send a period again
--                          as a 'manual' row. sent_to, provider and provider_message_id are set when
--                          the provider accepted the email.
--
-- Both tables hold people's email addresses: RLS is on and nothing is granted to authenticated or
-- anon (0006). Only the service, which owns them, reads them.

CREATE TABLE app.email_report (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company(id),
  name           text NOT NULL CHECK (btrim(name) <> ''),
  kind           text NOT NULL DEFAULT 'rows' CHECK (kind IN ('rows')),
  campaign_ids   uuid[],                                     -- NULL = every campaign of the company
  recipients     text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 20),
  schedule_cron  text NOT NULL,
  timezone       text NOT NULL DEFAULT 'Europe/Zurich',
  report_window  text NOT NULL DEFAULT 'previous_day'
                   CHECK (report_window IN ('previous_day', 'previous_week', 'previous_month')),
  settings       jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  enabled        boolean NOT NULL DEFAULT true,
  next_run_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_report_due ON app.email_report (next_run_at) WHERE enabled;
CREATE INDEX email_report_company ON app.email_report (company_id);
ALTER TABLE app.email_report ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  app.email_report            IS 'A report emailed on a schedule (src/modules/email-reports). Holds email addresses: never granted.';
COMMENT ON COLUMN app.email_report.kind       IS 'What the report is; rows = the flat rows of a webhook column list.';
COMMENT ON COLUMN app.email_report.recipients IS 'Everyone in To of one email, 1-20 addresses.';
COMMENT ON COLUMN app.email_report.settings   IS 'Per kind; rows: { format: csv | json, fields: column list }.';

CREATE TABLE app.email_report_delivery (
  id                   uuid PRIMARY KEY,                     -- minted before the document is built
  email_report_id      uuid NOT NULL REFERENCES app.email_report(id) ON DELETE CASCADE,
  period_start         date NOT NULL,
  period_end           date NOT NULL CHECK (period_end >= period_start),
  trigger              text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts             int  NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz,                          -- the ladder: 1 m, 5 m, 30 m, 2 h, 12 h
  last_attempt_at      timestamptz,
  document             text NOT NULL,                        -- the exact attachment
  content_type         text NOT NULL,
  sent_to              text[],                               -- who it went to, once delivered
  provider             text,                                 -- e.g. 'resend'
  provider_message_id  text,
  error_excerpt        text,                                 -- why the last attempt failed; no address
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_report_delivery_scheduled_period
  ON app.email_report_delivery (email_report_id, period_start, period_end)
  WHERE trigger = 'schedule';
-- The foreign key, and the latest delivery of a period (send-now, the list).
CREATE INDEX email_report_delivery_period
  ON app.email_report_delivery (email_report_id, period_start, period_end, created_at DESC);
CREATE INDEX email_report_delivery_due
  ON app.email_report_delivery (status, next_attempt_at) WHERE status = 'pending';
ALTER TABLE app.email_report_delivery ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  app.email_report_delivery          IS 'One email of one period; the idempotency record. Holds email addresses: never granted.';
COMMENT ON COLUMN app.email_report_delivery.document IS 'The exact attachment, rendered once with this row''s id.';
COMMENT ON COLUMN app.email_report_delivery.sent_to  IS 'The recipients the provider accepted the email for.';
