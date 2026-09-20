-- One webhook row, for the send-now route.
SELECT id, name, url, secret, schedule_cron, timezone, report_window, enabled, next_run_at
  FROM app.webhook
 WHERE id = $1;
