-- The name a creative-level row prints for a campaign_tag: the creative's own name (app.creative,
-- migration 0011), for the campaigns the webhook reports on. One name per creative, whichever
-- source's rows it is printed on. A tag without a creative is not here; rows.ts prints the tag.
SELECT c.campaign_id,
       c.tag AS campaign_tag,
       c.name AS label
  FROM app.creative c
  JOIN app.campaign ca ON ca.id = c.campaign_id
 WHERE ca.company_id = $1
   AND ($2::uuid[] IS NULL OR ca.id = ANY ($2::uuid[]));
