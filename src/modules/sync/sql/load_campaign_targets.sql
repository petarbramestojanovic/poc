-- Page and CTA ids defined for the campaign; synced rows may only reference these.
SELECT 'page' AS kind, page_id AS id FROM analytics.page WHERE campaign_id = $1
UNION ALL
SELECT 'cta' AS kind, cta_id AS id FROM analytics.cta WHERE campaign_id = $1
