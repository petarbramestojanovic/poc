-- campaign_ids NULL = every campaign of the company, now and later; payload_fields NULL = the
-- full v1 body.
INSERT INTO app.webhook
  (company_id, name, campaign_ids, url, secret, schedule_cron, timezone, report_window,
   include_check_sources, include_creatives, enabled, next_run_at, payload_fields)
VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
RETURNING id;
