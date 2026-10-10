-- Claims the oldest due delivery for one attempt, and counts that attempt. next_attempt_at moves
-- to the end of a lease ($2), so no other tick, replica or send-now can take the same row while
-- this attempt is in flight; SKIP LOCKED lets a concurrent claimer move on instead of waiting. An
-- attempt that dies in flight (crash, hard exit) is claimed again once its lease runs out. Only
-- the attempt holding this count may record an outcome (record_attempt.sql).
WITH due AS (
  SELECT d.id
    FROM app.webhook_delivery d
    JOIN app.webhook w ON w.id = d.webhook_id
   WHERE d.status = 'pending'
     AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= $1)
     AND w.enabled
   ORDER BY d.created_at
   LIMIT 1
     FOR UPDATE OF d SKIP LOCKED
)
UPDATE app.webhook_delivery d
   SET attempts = d.attempts + 1,
       next_attempt_at = $2
  FROM due, app.webhook w
 WHERE d.id = due.id
   AND w.id = d.webhook_id
RETURNING d.id, d.webhook_id, d.period_start, d.period_end, d.attempts, d.payload,
          w.url, w.secret, w.format, w.auth_header, w.auth_token;
