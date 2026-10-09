-- One check-source block, for a calculated field whose source the webhook's own build left out
-- (check sources switched off). $5 = the webhook's include_creatives.
SELECT app.webhook_source_block($1, $2, 'check', $3::date, $4::date, $5) AS block;
