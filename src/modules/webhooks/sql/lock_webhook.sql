-- The webhook a PATCH changes, locked until it commits, so two edits cannot interleave and a
-- tick enqueueing it (load_due_webhooks.sql, FOR UPDATE) waits for the edit or is waited for.
SELECT id, company_id, name, campaign_ids, url, schedule_cron, timezone, report_window, format,
       auth_header, auth_token, enabled, next_run_at, payload_fields
  FROM app.webhook
 WHERE id = $1
   FOR UPDATE;
