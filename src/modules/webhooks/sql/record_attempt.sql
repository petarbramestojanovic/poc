-- The outcome of one attempt: delivered, or pending with the next slot on the ladder, or failed
-- after the last one. The attempt was counted when it was claimed, and it records only while the
-- row is still pending with that count: a row a re-send re-queued meanwhile, or one another
-- attempt already finished, is left as it is. response_excerpt is already redacted and truncated.
UPDATE app.webhook_delivery
   SET last_attempt_at = $2,
       status = $3,
       next_attempt_at = $4,
       response_code = $5,
       response_excerpt = $6
 WHERE id = $1
   AND status = 'pending'
   AND attempts = $7
RETURNING id;
