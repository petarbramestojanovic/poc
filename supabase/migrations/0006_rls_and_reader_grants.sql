-- 0006_rls_and_reader_grants.sql — row level security, and a logged-in reader for the console.
--
-- PHASE 2 WORK BROUGHT FORWARD, approved by the product owner on 2026-09-23. CLAUDE.md defers RLS
-- and Supabase Auth to phase 2; the local React console reads analytics straight from Supabase
-- (RFC-002 §15: the dashboard calls these functions through supabase.rpc()), so the access model
-- they need exists now. No table, column or key of RFC-004 changes here.
--
-- The model, deliberately simple: every logged-in user reads everything that is granted. Scoping a
-- user to one company needs a user↔company mapping, which is new tables and belongs with the real
-- dashboard. Until then the only users are the ones we create by hand, and two Supabase settings
-- carry that weight: anonymous sign-ins OFF (an anonymous session also carries the `authenticated`
-- role) and public sign-ups OFF.
--
-- What each role may do after this migration:
--   postgres (the service)  unchanged — it owns these tables and bypasses RLS.
--   authenticated           SELECT on the analytics tables, the operational tables the console
--                           shows, and app.campaign (the read functions resolve a campaign's
--                           primary source through it).
--   anon (the browser key   nothing at all: no schema usage, no grants, no policy.
--        before a login)
--
-- Never granted, on purpose: external.credential (points at secret env vars), external.raw_payload
-- (vendor responses), app.company, app.webhook (holds the signing secret) and app.webhook_delivery.
-- RLS is enabled on them anyway, so a future grant by accident still reads nothing.

-- --------------------------------------------------------------------------------------------
-- 1. RLS on every table. No FORCE: the service owns these tables and must keep working.
-- --------------------------------------------------------------------------------------------

ALTER TABLE app.company                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_delivery           ENABLE ROW LEVEL SECURITY;

ALTER TABLE analytics.metric               ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.cta                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.page                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.advanced_analytics   ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.cta_clicks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.page_views           ENABLE ROW LEVEL SECURITY;

ALTER TABLE external.source                ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.source_metric         ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.credential            ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.campaign_link         ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.link_entity           ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.event_map             ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.sync_run              ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.sync_state            ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.unmapped_event        ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.raw_payload           ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------------------------
-- 2. What a logged-in reader may select. A grant without a policy still reads nothing, and a
--    policy without a grant is never reached: both are needed, so both are listed per table.
-- --------------------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA app, analytics, external TO authenticated;

-- app.campaign: analytics.resolve_source reads it to find a campaign's primary source, and these
-- functions run as the caller (SECURITY INVOKER), so the caller needs it. Nothing else in `app`.
GRANT SELECT ON app.campaign TO authenticated;
CREATE POLICY read_authenticated ON app.campaign FOR SELECT TO authenticated USING (true);

GRANT SELECT ON
  analytics.metric, analytics.cta, analytics.page,
  analytics.advanced_analytics, analytics.cta_clicks, analytics.page_views
  TO authenticated;
CREATE POLICY read_authenticated ON analytics.metric             FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON analytics.cta                FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON analytics.page               FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON analytics.advanced_analytics FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON analytics.cta_clicks         FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON analytics.page_views         FOR SELECT TO authenticated USING (true);

-- The operational tables the console's Sync tab shows. credential and raw_payload are not here.
GRANT SELECT ON
  external.source, external.source_metric, external.campaign_link, external.link_entity,
  external.event_map, external.sync_run, external.sync_state, external.unmapped_event
  TO authenticated;
CREATE POLICY read_authenticated ON external.source         FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON external.source_metric  FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON external.campaign_link  FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON external.link_entity    FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON external.event_map      FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON external.sync_run       FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON external.sync_state     FOR SELECT TO authenticated USING (true);
CREATE POLICY read_authenticated ON external.unmapped_event FOR SELECT TO authenticated USING (true);

-- --------------------------------------------------------------------------------------------
-- 3. Functions. Postgres grants EXECUTE to PUBLIC on every new function, so the payload builders
--    are taken back first: they are the service's, not a reader's.
-- --------------------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  app.build_webhook_payload(uuid, date, date),
  app.webhook_source_block(uuid, text, text, date, date, boolean),
  app.metrics_json(jsonb, text[])
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  analytics.resolve_source(uuid, text),
  analytics.get_engagement_daily(uuid, date, date, text),
  analytics.get_engagement_totals(uuid, date, date, text),
  analytics.get_creative_breakdown(uuid, date, date, text),
  analytics.get_page_views(uuid, date, date, text),
  analytics.get_cta_clicks(uuid, date, date, text),
  analytics.get_source_status(uuid, date, date, text)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  analytics.resolve_source(uuid, text),
  analytics.get_engagement_daily(uuid, date, date, text),
  analytics.get_engagement_totals(uuid, date, date, text),
  analytics.get_creative_breakdown(uuid, date, date, text),
  analytics.get_page_views(uuid, date, date, text),
  analytics.get_cta_clicks(uuid, date, date, text),
  analytics.get_source_status(uuid, date, date, text)
  TO authenticated;

COMMENT ON POLICY read_authenticated ON analytics.advanced_analytics IS
  'Every logged-in user reads every campaign. Per-company scoping arrives with the dashboard.';
