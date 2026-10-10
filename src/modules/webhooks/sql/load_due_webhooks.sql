-- Webhooks whose next run has come. FOR UPDATE SKIP LOCKED so two ticks can never enqueue the
-- same period twice, even if the leader lock were ever bypassed; the caller is inside a
-- transaction and recomputes next_run_at before it commits. A webhook still waiting for its data
-- stays due, and is looked at again by the next tick.
SELECT id, name, company_id, campaign_ids, url, secret, schedule_cron, timezone, report_window,
       format, enabled, next_run_at, payload_fields
  FROM app.webhook
 WHERE enabled AND next_run_at <= $1
 ORDER BY next_run_at
 LIMIT $2
   FOR UPDATE SKIP LOCKED;
