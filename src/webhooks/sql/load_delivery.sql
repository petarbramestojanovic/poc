-- One pending delivery with everything an attempt needs, for send-now's immediate try.
SELECT d.id, d.webhook_id, d.period_start, d.period_end, d.attempts, d.payload,
       w.url, w.secret
  FROM app.webhook_delivery d
  JOIN app.webhook w ON w.id = d.webhook_id
 WHERE d.id = $1 AND d.status = 'pending';
