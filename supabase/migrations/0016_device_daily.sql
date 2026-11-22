-- 0016_device_daily.sql — the device split: delivery per creative, device and day.
--
-- ADDITION BESIDE RFC-004'S TABLES, approved by the product owner on 2026-11-22. It also deviates
-- from RFC-003 §2.4, which plans `external.device_daily` keyed by link: docs/RFC-003 and RFC-004
-- are kept verbatim, so this header is the record. Additive: nothing existing changes.
--
-- A platform can say on which kind of device an ad was shown (Zeus: /reports/devices). The split
-- must be readable per creative, so the table carries the key of the analytics tables
-- (campaign, source, language, creative tag, day) plus the device, and lives beside them in
-- `analytics`: a link is rebuilt when its ids change, a campaign's numbers are not. It is its
-- own table and not a column of advanced_analytics, where total rows and device rows would sit
-- side by side and every read that forgot to filter would count a day twice.
--
--   campaign_tag   the creative (app.creative.tag); '' = the campaign's own row. A source that
--                  reports devices per campaign only (Zeus, 2026-11) writes '' rows; one level
--                  per link and day, never both, so a campaign's split is the sum over its tags.
--   device_type    'desktop' | 'mobile' | 'tablet' | 'unknown'. A connector maps its platform's
--                  names onto these; what the platform cannot tell, or names in a way we do not
--                  know, is 'unknown', so the devices still add up to the delivery.
--   impressions, in_view, clicks
--                  counts, all added up when read (a share is a division at read time, never
--                  stored). NULL = the platform does not measure it per device, never 0.
--
-- Written by the day-replace of a sync (src/modules/sync/writer.ts): the whole
-- (campaign, source, language, day) slice is deleted and inserted in the transaction that
-- replaces the day in the three rollup tables, under the same lock. Not in analytics.metric: no
-- report formula reads a device count.

CREATE TABLE analytics.device_daily (
  campaign_id   uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  source        text NOT NULL REFERENCES external.source(id),
  language      text NOT NULL DEFAULT '',                       -- '' = not split
  campaign_tag  text NOT NULL DEFAULT '',                       -- creative-level dimension; '' = the campaign's own row
  device_type   text NOT NULL CHECK (device_type IN ('desktop', 'mobile', 'tablet', 'unknown')),
  events_date   date NOT NULL,                                  -- the source's day (external.source.day_timezone)
  impressions   bigint CHECK (impressions >= 0),
  in_view       bigint CHECK (in_view >= 0),
  clicks        bigint CHECK (clicks >= 0),
  data_source   text NOT NULL DEFAULT 'live' CHECK (data_source IN ('live', 'sync', 'legacy_aurora')),
  sync_run_id   uuid REFERENCES external.sync_run(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, source, language, campaign_tag, device_type, events_date)
);
-- Two new indexes, as every foreign-key column gets one (the primary key covers campaign_id).
CREATE INDEX device_daily_source_idx ON analytics.device_daily (source);
CREATE INDEX device_daily_sync_run_id_idx ON analytics.device_daily (sync_run_id);

COMMENT ON TABLE analytics.device_daily IS
  'Delivery per creative, device and day. Same key as the rollup tables plus device_type; replaced day by day with them.';
COMMENT ON COLUMN analytics.device_daily.campaign_tag IS
  'The creative''s tag; '''' = the campaign''s own row. One level per link and day, never both.';
COMMENT ON COLUMN analytics.device_daily.device_type IS
  'desktop | mobile | tablet | unknown. unknown = the platform could not tell, or named a device we do not know.';

-- A logged-in reader sees it like the other analytics tables (0006); anon has nothing.
ALTER TABLE analytics.device_daily ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON analytics.device_daily TO authenticated;
CREATE POLICY read_authenticated ON analytics.device_daily FOR SELECT TO authenticated USING (true);
