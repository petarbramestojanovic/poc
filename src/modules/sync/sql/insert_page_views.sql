INSERT INTO analytics.page_views (campaign_id, source, language, campaign_tag, page_id, events_date, view_counter, data_source, sync_run_id)
SELECT $1, $2, $3, t.campaign_tag, t.page_id, $4, t.count, 'sync', $5
  FROM unnest($6::text[], $7::text[], $8::bigint[]) AS t(campaign_tag, page_id, count)
