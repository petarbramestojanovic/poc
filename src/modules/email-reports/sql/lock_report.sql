-- The report a PATCH changes, locked until it commits, so two edits cannot interleave and a tick
-- enqueueing it (load_due_reports.sql, FOR UPDATE) waits for the edit or is waited for.
SELECT id, company_id, name, kind, campaign_ids, recipients, schedule_cron, timezone,
       report_window, settings, enabled, next_run_at
  FROM app.email_report
 WHERE id = $1
   FOR UPDATE;
