-- Seconds since the most recent real (non-dry-run) run of the link, for the manual-run cooldown.
-- Measured by Postgres so the service clock plays no part.
SELECT EXTRACT(EPOCH FROM now() - started_at)::float8 AS elapsed_seconds
  FROM external.sync_run
 WHERE link_id = $1 AND dry_run = false
 ORDER BY started_at DESC
 LIMIT 1
