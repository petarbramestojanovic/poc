-- One webhook row, for send-now and preview.
SELECT id, name, url, secret, schedule_cron, timezone, report_window, enabled, next_run_at,
       include_creatives, payload_fields
  FROM app.webhook
 WHERE id = $1;
