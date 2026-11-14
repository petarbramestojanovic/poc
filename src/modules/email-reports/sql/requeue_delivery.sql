-- A manual re-send of a period whose latest delivery is pending or failed: the same delivery id, a
-- freshly built document ($2, $3), and the ladder back at zero. The trigger stays what it was, so a
-- scheduled row keeps guarding its period. A delivered row is never re-queued: sending it again is
-- a new delivery (insert_delivery.sql).
UPDATE app.email_report_delivery
   SET status = 'pending',
       attempts = 0,
       next_attempt_at = NULL,
       error_excerpt = NULL,
       document = $2,
       content_type = $3
 WHERE id = $1 AND status <> 'delivered'
RETURNING id;
