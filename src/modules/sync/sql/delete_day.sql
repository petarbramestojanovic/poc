-- The whole (campaign, source, language, day) slice, in the three rollup tables and the device
-- split (RFC-003 §4).
WITH a AS (
  DELETE FROM analytics.advanced_analytics
   WHERE campaign_id = $1 AND source = $2 AND language = $3 AND events_date = $4
   RETURNING 1
), p AS (
  DELETE FROM analytics.page_views
   WHERE campaign_id = $1 AND source = $2 AND language = $3 AND events_date = $4
   RETURNING 1
), c AS (
  DELETE FROM analytics.cta_clicks
   WHERE campaign_id = $1 AND source = $2 AND language = $3 AND events_date = $4
   RETURNING 1
), d AS (
  DELETE FROM analytics.device_daily
   WHERE campaign_id = $1 AND source = $2 AND language = $3 AND events_date = $4
   RETURNING 1
)
SELECT (SELECT count(*) FROM a)::int AS advanced,
       (SELECT count(*) FROM p)::int AS page_views,
       (SELECT count(*) FROM c)::int AS cta_clicks,
       (SELECT count(*) FROM d)::int AS devices
