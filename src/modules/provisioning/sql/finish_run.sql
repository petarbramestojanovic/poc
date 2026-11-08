-- Closes a run, as succeeded ($2 NULL) or failed ($2 the redacted error).
UPDATE external.provisioning_run
   SET status = CASE WHEN $2::text IS NULL THEN 'succeeded' ELSE 'failed' END,
       finished_at = now(),
       error = $2,
       warnings = $3::jsonb,
       steps = $4::jsonb
 WHERE id = $1 AND status = 'running';
