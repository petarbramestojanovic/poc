-- The delivery row and the document it will send ($6, rendered once by src/modules/webhooks/build.ts
-- with this row's id $1 inside it), stored as text so the bytes signed, sent and served later are
-- exactly these. The id travels as X-Delivery-Id and stays the same across every retry.
--
-- The schedule sends a period once: a second scheduled row for the same (webhook, period) conflicts
-- on webhook_delivery_scheduled_period (migration 0008) and nothing is inserted, so a repeated tick
-- is a no-op rather than a second report. A manual row ($5 = 'manual') never conflicts: a person
-- may send a period that was already delivered again, as a delivery of its own.
INSERT INTO app.webhook_delivery (id, webhook_id, period_start, period_end, trigger, payload)
VALUES ($1, $2, $3::date, $4::date, $5, to_jsonb($6::text))
    ON CONFLICT (webhook_id, period_start, period_end) WHERE trigger = 'schedule' DO NOTHING
RETURNING id;
