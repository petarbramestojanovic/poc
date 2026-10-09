-- Which of these campaigns are linked to which of these sources: a calculated field's source block
-- is added only where the campaign has a link, as the payload builder does for check sources.
SELECT DISTINCT campaign_id, source_id
  FROM external.campaign_link
 WHERE campaign_id = ANY ($1::uuid[])
   AND source_id = ANY ($2::text[]);
