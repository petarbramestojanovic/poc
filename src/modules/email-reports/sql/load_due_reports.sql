-- Reports whose next run has come. FOR UPDATE SKIP LOCKED so two ticks can never enqueue the same
-- period twice, even if the leader lock were ever bypassed; the caller is inside a transaction and
-- moves next_run_at on before it commits. A report still waiting for its data stays due, and is
-- looked at again by the next tick.
SELECT id, company_id, name, kind, campaign_ids, recipients, schedule_cron, timezone,
       report_window, settings, enabled, next_run_at
  FROM app.email_report
 WHERE enabled AND next_run_at <= $1
 ORDER BY next_run_at
 LIMIT $2
   FOR UPDATE SKIP LOCKED;
