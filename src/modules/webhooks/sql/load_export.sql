-- A CSV delivery behind a signed link (src/modules/webhooks/exports.ts), with the secret that signs
-- the link. The route answers 404 unless the signature, the expiry, the format and the webhook's
-- enabled flag all hold.
SELECT d.id, d.webhook_id, d.payload, w.secret, w.format, w.enabled
  FROM app.webhook_delivery d
  JOIN app.webhook w ON w.id = d.webhook_id
 WHERE d.id = $1;
