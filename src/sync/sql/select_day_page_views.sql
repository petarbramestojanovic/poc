SELECT campaign_tag, page_id, view_counter AS count
  FROM analytics.page_views
 WHERE campaign_id = $1 AND source = $2 AND language = $3 AND events_date = $4
