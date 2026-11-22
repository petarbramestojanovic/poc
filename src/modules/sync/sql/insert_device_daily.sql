INSERT INTO analytics.device_daily (
  campaign_id, source, language, campaign_tag, device_type, events_date,
  impressions, in_view, clicks,
  data_source, sync_run_id
)
SELECT $1, $2, $3, t.campaign_tag, t.device_type, $4,
       t.impressions, t.in_view, t.clicks,
       'sync', $5
  FROM unnest($6::text[], $7::text[], $8::bigint[], $9::bigint[], $10::bigint[])
       AS t(campaign_tag, device_type, impressions, in_view, clicks)
