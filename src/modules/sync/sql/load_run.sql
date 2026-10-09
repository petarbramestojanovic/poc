-- One run for the status endpoint (RFC-003 §5: callers poll external.sync_run).
SELECT id, link_id, trigger, dry_run, status, window_from, window_to,
       started_at, finished_at, days_written, rows_written, warnings, error
  FROM external.sync_run
 WHERE id = $1
