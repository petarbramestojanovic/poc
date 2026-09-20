-- A manual re-send of a period that already has a row: the same delivery id, a freshly built
-- payload (the numbers have moved on since the failure), and the attempt ladder back at zero.
-- A delivered period is never re-queued; the route refuses it before this runs.
UPDATE app.webhook_delivery
   SET status = 'pending',
       trigger = 'manual',
       attempts = 0,
       next_attempt_at = NULL,
       response_code = NULL,
       response_excerpt = NULL,
       payload = jsonb_set(
         app.build_webhook_payload(webhook_id, period_start, period_end),
         '{delivery_id}',
         to_jsonb(id)
       )
 WHERE id = $1 AND status <> 'delivered'
RETURNING id;
