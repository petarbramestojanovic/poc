-- Every setting of a webhook a PATCH may change, merged and validated by admin.ts. The company and
-- the signing secret never change. Applies from the next report built: a queued delivery keeps the
-- document it was stored with.
UPDATE app.webhook
   SET name = $2,
       campaign_ids = $3::uuid[],
       url = $4,
       schedule_cron = $5,
       timezone = $6,
       report_window = $7,
       format = $8,
       auth_header = $9,
       auth_token = $10,
       payload_fields = $11::jsonb,
       enabled = $12,
       next_run_at = $13,
       updated_at = now()
 WHERE id = $1;
