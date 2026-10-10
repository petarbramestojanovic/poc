-- The campaigns a webhook reports on (never archived ones), with what its formulas need: a price,
-- and a link to the webhook's source ($3). $2 NULL = every campaign of the company.
SELECT c.name,
       c.price IS NOT NULL AS has_price,
       EXISTS (SELECT 1
                 FROM external.campaign_link l
                WHERE l.campaign_id = c.id AND l.source_id = $3) AS linked
  FROM app.campaign c
 WHERE c.company_id = $1
   AND c.status <> 'archived'
   AND ($2::uuid[] IS NULL OR c.id = ANY ($2::uuid[]))
 ORDER BY c.name, c.id;
