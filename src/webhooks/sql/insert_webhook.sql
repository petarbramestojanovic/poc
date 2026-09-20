-- campaign_ids NULL = every campaign of the company, now and later.
INSERT INTO app.webhook
  (company_id, name, campaign_ids, url, secret, schedule_cron, timezone, report_window,
   include_check_sources, include_creatives, enabled, next_run_at)
VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id;
