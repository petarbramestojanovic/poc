-- One webhook row, for send-now and preview.
SELECT id, name, company_id, campaign_ids, url, secret, schedule_cron, timezone, report_window,
       format, enabled, next_run_at, payload_fields
  FROM app.webhook
 WHERE id = $1;
