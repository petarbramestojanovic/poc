INSERT INTO analytics.advanced_analytics (
  campaign_id, source, language, campaign_tag, events_date,
  impressions, in_view, game_started, game_finished, interactions, hovered,
  in_view_time, dwell_time, interaction_time, dwell_avg_ms,
  unique_impressions_reported, unique_clicks_reported,
  data_source, sync_run_id
)
SELECT $1, $2, $3, t.campaign_tag, $4,
       t.impressions, t.in_view, t.game_started, t.game_finished, t.interactions, t.hovered,
       t.in_view_time, t.dwell_time, t.interaction_time, t.dwell_avg_ms,
       t.unique_impressions_reported, t.unique_clicks_reported,
       'sync', $5
  FROM unnest(
    $6::text[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[], $11::bigint[], $12::bigint[],
    $13::bigint[], $14::bigint[], $15::bigint[], $16::numeric[], $17::bigint[], $18::bigint[]
  ) AS t(
    campaign_tag, impressions, in_view, game_started, game_finished, interactions, hovered,
    in_view_time, dwell_time, interaction_time, dwell_avg_ms,
    unique_impressions_reported, unique_clicks_reported
  )
