-- Webhooks whose next run has come. FOR UPDATE SKIP LOCKED so two ticks can never enqueue the
-- same period twice, even if the leader lock were ever bypassed; the caller is inside a
-- transaction and recomputes next_run_at before it commits.
SELECT id, name, url, secret, schedule_cron, timezone, report_window, enabled, next_run_at
  FROM app.webhook
 WHERE enabled AND next_run_at <= $1
 ORDER BY next_run_at
 LIMIT $2
   FOR UPDATE SKIP LOCKED;
