SELECT campaign_tag, impressions, in_view, game_started, game_finished, interactions, hovered,
       in_view_time, dwell_time, interaction_time, dwell_avg_ms,
       unique_impressions_reported, unique_clicks_reported
  FROM analytics.advanced_analytics
 WHERE campaign_id = $1 AND source = $2 AND language = $3 AND events_date = $4
