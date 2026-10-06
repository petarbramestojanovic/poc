-- The full v1 body of one webhook for one period. A webhook with a field list narrows it and adds
-- its calculated fields in src/webhooks/fields.ts before it is stored.
SELECT app.build_webhook_payload($1, $2::date, $3::date) AS payload;
