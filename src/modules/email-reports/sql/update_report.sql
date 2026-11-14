-- Every setting a PATCH may change, merged and checked by admin.ts. The company and the kind never
-- change. Applies from the next report built: a queued delivery keeps the document it was stored
-- with, and is sent to the recipients the report has at that attempt.
UPDATE app.email_report
   SET name = $2,
       campaign_ids = $3::uuid[],
       recipients = $4::text[],
       schedule_cron = $5,
       timezone = $6,
       report_window = $7,
       settings = $8::jsonb,
       enabled = $9,
       next_run_at = $10,
       updated_at = now()
 WHERE id = $1;
