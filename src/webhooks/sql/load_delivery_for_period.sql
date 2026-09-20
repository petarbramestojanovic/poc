SELECT id, status, attempts
  FROM app.webhook_delivery
 WHERE webhook_id = $1 AND period_start = $2::date AND period_end = $3::date;
