-- The latest delivery of one period, scheduled or manual: send-now re-queues it while it is pending
-- or failed, and sends the period as a new delivery once it was delivered.
SELECT id, status, attempts
  FROM app.email_report_delivery
 WHERE email_report_id = $1 AND period_start = $2::date AND period_end = $3::date
 ORDER BY created_at DESC, id DESC
 LIMIT 1;
