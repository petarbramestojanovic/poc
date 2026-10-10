-- campaign_ids NULL = every campaign of the company, now and later. payload_fields is the column
-- list (src/modules/webhooks/fields.ts); report_window holds the frequency (periods.ts).
INSERT INTO app.webhook
  (company_id, name, campaign_ids, url, secret, schedule_cron, timezone, report_window, format,
   auth_header, auth_token, payload_version, enabled, next_run_at, payload_fields)
VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
RETURNING id;
