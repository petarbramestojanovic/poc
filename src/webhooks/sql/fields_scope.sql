-- The campaigns a webhook reports on (never archived ones), with what its calculated fields need:
-- a price, and a link to each source a formula reads. $2 NULL = every campaign of the company.
SELECT c.name,
       c.price IS NOT NULL AS has_price,
       coalesce(array_agg(DISTINCT l.source_id) FILTER (WHERE l.source_id IS NOT NULL), '{}'::text[])
         AS sources
  FROM app.campaign c
  LEFT JOIN external.campaign_link l ON l.campaign_id = c.id
 WHERE c.company_id = $1
   AND c.status <> 'archived'
   AND ($2::uuid[] IS NULL OR c.id = ANY ($2::uuid[]))
 GROUP BY c.id, c.name, c.price
 ORDER BY c.name, c.id;
