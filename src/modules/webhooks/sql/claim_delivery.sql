-- send-now's immediate attempt: claims one delivery by id on the same terms as the tick
-- (claim_next_delivery.sql). Nothing comes back when the row is not pending, not due, or already
-- claimed by an attempt in flight; that attempt, or a later tick, sends it.
UPDATE app.webhook_delivery d
   SET attempts = d.attempts + 1,
       next_attempt_at = $3
  FROM app.webhook w
 WHERE d.id = $1
   AND w.id = d.webhook_id
   AND w.enabled
   AND d.status = 'pending'
   AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= $2)
RETURNING d.id, d.webhook_id, d.period_start, d.period_end, d.attempts, d.payload,
          w.url, w.secret;
