-- Claims the oldest due delivery for one attempt, and counts that attempt. next_attempt_at moves to
-- the end of a lease ($2), so no other tick, replica or send-now can take the same row while this
-- attempt is in flight; SKIP LOCKED lets a concurrent claimer move on instead of waiting. An attempt
-- that dies in flight is claimed again once its lease runs out. Only the attempt holding this count
-- may record an outcome (record_attempt.sql). The recipients are the report's as of now.
WITH due AS (
  SELECT d.id
    FROM app.email_report_delivery d
    JOIN app.email_report r ON r.id = d.email_report_id
   WHERE d.status = 'pending'
     AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= $1)
     AND r.enabled
   ORDER BY d.created_at
   LIMIT 1
     FOR UPDATE OF d SKIP LOCKED
)
UPDATE app.email_report_delivery d
   SET attempts = d.attempts + 1,
       next_attempt_at = $2
  FROM due, app.email_report r
 WHERE d.id = due.id
   AND r.id = d.email_report_id
RETURNING d.id, d.email_report_id, d.period_start, d.period_end, d.attempts, d.document,
          d.content_type, r.name, r.recipients, r.timezone;
