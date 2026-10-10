-- A manual re-send of a period whose latest delivery is pending or failed: the same delivery id, a
-- freshly rendered document ($2, carrying that id — the numbers have moved on since the failure),
-- and the attempt ladder back at zero. The trigger stays what it was, so a scheduled row keeps
-- guarding its period against a second scheduled report. A delivered row is never re-queued: send
-- again, and it is a new delivery (insert_delivery.sql).
UPDATE app.webhook_delivery
   SET status = 'pending',
       attempts = 0,
       next_attempt_at = NULL,
       response_code = NULL,
       response_excerpt = NULL,
       payload = to_jsonb($2::text)
 WHERE id = $1 AND status <> 'delivered'
RETURNING id;
