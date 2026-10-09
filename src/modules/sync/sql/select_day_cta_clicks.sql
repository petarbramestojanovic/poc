SELECT campaign_tag, cta_id, cta_counter AS count
  FROM analytics.cta_clicks
 WHERE campaign_id = $1 AND source = $2 AND language = $3 AND events_date = $4
