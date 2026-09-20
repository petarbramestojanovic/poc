-- Moves the schedule forward. Done in the same transaction as the delivery insert, so a crash
-- between the two cannot skip a period.
UPDATE app.webhook
   SET next_run_at = $2, updated_at = now()
 WHERE id = $1;
