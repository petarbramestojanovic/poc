-- The outcome of one attempt: delivered, or pending with the next slot on the ladder, or failed
-- after the last one. response_excerpt is already redacted and truncated by the caller.
UPDATE app.webhook_delivery
   SET attempts = attempts + 1,
       last_attempt_at = $2,
       status = $3,
       next_attempt_at = $4,
       response_code = $5,
       response_excerpt = $6
 WHERE id = $1;
