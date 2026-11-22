SELECT device_type, impressions, in_view, clicks
  FROM analytics.device_daily
 WHERE campaign_id = $1 AND source = $2 AND language = $3 AND events_date = $4
