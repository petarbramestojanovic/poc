-- One report, for send-now and preview.
SELECT id, company_id, name, kind, campaign_ids, recipients, schedule_cron, timezone,
       report_window, settings, enabled, next_run_at
  FROM app.email_report
 WHERE id = $1;
