-- A new email report. campaign_ids NULL = every campaign of the company, now and later; settings
-- were checked by the report's kind (src/modules/email-reports/kinds/).
INSERT INTO app.email_report
  (company_id, name, kind, campaign_ids, recipients, schedule_cron, timezone, report_window,
   settings, enabled, next_run_at)
VALUES ($1, $2, $3, $4::uuid[], $5::text[], $6, $7, $8, $9::jsonb, $10, $11)
RETURNING id;
