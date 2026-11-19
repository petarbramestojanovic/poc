-- Opens a run for a campaign unless one is running: the check and the insert happen under the
-- campaign's provisioning lock, in one statement, so two triggers cannot both start creating.
-- Returns no row when a run is in progress.
WITH gate AS (
  SELECT pg_advisory_xact_lock(hashtext('provisioning:' || $1::uuid::text))
),
running AS (
  SELECT 1 FROM external.provisioning_run, gate
   WHERE campaign_id = $1::uuid AND status = 'running'
     AND started_at > now() - interval '1 hour'
)
INSERT INTO external.provisioning_run (campaign_id, trigger)
SELECT $1::uuid, $2::text
 WHERE NOT EXISTS (SELECT 1 FROM running)
RETURNING id;
