-- Additive only: indexes, no table, column or key changes (RFC-004 stays the schema of record).
--
-- Postgres does not index foreign-key columns. Without these, deleting a sync_run — or the
-- 30-day raw_payload purge — scans every rollup table and the whole payload archive.
CREATE INDEX IF NOT EXISTS advanced_analytics_sync_run_id_idx ON analytics.advanced_analytics (sync_run_id);
CREATE INDEX IF NOT EXISTS page_views_sync_run_id_idx ON analytics.page_views (sync_run_id);
CREATE INDEX IF NOT EXISTS cta_clicks_sync_run_id_idx ON analytics.cta_clicks (sync_run_id);
CREATE INDEX IF NOT EXISTS raw_payload_sync_run_id_idx ON external.raw_payload (sync_run_id);
CREATE INDEX IF NOT EXISTS raw_payload_fetched_at_idx ON external.raw_payload (fetched_at);
