-- The delivery row and the body it will send ($5, built by src/webhooks/build.ts), in one
-- statement: the id is generated first and stamped into the payload, so X-Delivery-Id and
-- payload.delivery_id are the same value and stay the same across every retry. The unique
-- (webhook_id, period_start, period_end) makes a repeated tick a no-op rather than a second report.
INSERT INTO app.webhook_delivery (id, webhook_id, period_start, period_end, trigger, payload)
SELECT fresh.id, $1, $2::date, $3::date, $4,
       jsonb_set($5::jsonb, '{delivery_id}', to_jsonb(fresh.id))
  FROM (SELECT gen_random_uuid() AS id) AS fresh
    ON CONFLICT (webhook_id, period_start, period_end) DO NOTHING
RETURNING id;
