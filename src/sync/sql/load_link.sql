-- One row: the link with its source, credential pointer and campaign.
SELECT l.id, l.campaign_id, l.source_id, l.credential_id, l.language, l.config, l.enabled,
       s.display_name AS source_display_name, s.day_timezone, s.lookback_days, s.deep_lookback_days,
       s.max_window_days, EXTRACT(EPOCH FROM s.min_manual_interval)::int AS min_manual_interval_seconds,
       c.name AS credential_name, c.secret_env_var, c.account_scope, c.enabled AS credential_enabled,
       ca.company_id, ca.name AS campaign_name
  FROM external.campaign_link l
  JOIN external.source s ON s.id = l.source_id
  JOIN external.credential c ON c.id = l.credential_id
  JOIN app.campaign ca ON ca.id = l.campaign_id
 WHERE l.id = $1
