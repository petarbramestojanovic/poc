UPDATE external.sync_run
   SET status = 'succeeded', finished_at = now(), days_written = $2, rows_written = $3, warnings = $4::jsonb
 WHERE id = $1
