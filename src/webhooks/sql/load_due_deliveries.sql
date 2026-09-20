-- Deliveries waiting for a first attempt or for their next one. Ordered oldest first so a backlog
-- drains in the order the periods closed. Only the leader ticks, so no row-level claim is needed.
SELECT d.id, d.webhook_id, d.period_start, d.period_end, d.attempts, d.payload,
       w.url, w.secret
  FROM app.webhook_delivery d
  JOIN app.webhook w ON w.id = d.webhook_id
 WHERE d.status = 'pending'
   AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= $1)
   AND w.enabled
 ORDER BY d.created_at
 LIMIT $2;
