-- Evaluated under the per-link gate lock, in the same transaction as the insert_run that follows,
-- so two concurrent triggers can never both pass. A 'running' row older than 6 hours is treated
-- as abandoned by a crashed process rather than blocking the link forever.
SELECT EXISTS (
         SELECT 1 FROM external.sync_run
          WHERE link_id = $1 AND NOT dry_run AND status = 'running'
            AND started_at > now() - interval '6 hours'
       ) AS running,
       (SELECT EXTRACT(EPOCH FROM now() - max(started_at))::float8
          FROM external.sync_run
         WHERE link_id = $1 AND NOT dry_run) AS elapsed_seconds
