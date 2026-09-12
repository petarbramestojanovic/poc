INSERT INTO external.sync_run (link_id, trigger, triggered_by, window_from, window_to, dry_run)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id
