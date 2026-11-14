-- The outcome of one attempt: delivered (with whom it went to and the provider's id), pending with
-- the next slot on the ladder, or failed after the last one. Lands only while the row is still
-- pending with this attempt's count: a row a re-send re-queued meanwhile, or one another attempt
-- already finished, is left as it is. error_excerpt holds no address (deliver.ts).
UPDATE app.email_report_delivery
   SET last_attempt_at = $2,
       status = $3,
       next_attempt_at = $4,
       error_excerpt = $5,
       sent_to = $6::text[],
       provider = $7,
       provider_message_id = $8
 WHERE id = $1
   AND status = 'pending'
   AND attempts = $9
RETURNING id;
