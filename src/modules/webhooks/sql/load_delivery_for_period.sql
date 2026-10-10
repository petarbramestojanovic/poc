-- The latest delivery of one period, scheduled or manual: send-now re-queues it while it is pending
-- or failed, and sends the period as a new delivery once it was delivered.
SELECT id, status, attempts
  FROM app.webhook_delivery
 WHERE webhook_id = $1 AND period_start = $2::date AND period_end = $3::date
 ORDER BY created_at DESC, id DESC
 LIMIT 1;
