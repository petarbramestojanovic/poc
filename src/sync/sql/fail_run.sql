UPDATE external.sync_run
   SET status = 'failed', finished_at = now(), error = $2, warnings = $3::jsonb
 WHERE id = $1
