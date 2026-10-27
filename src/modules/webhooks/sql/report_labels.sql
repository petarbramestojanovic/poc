-- The name a creative-level row prints for a campaign_tag: the label of the creative entity that
-- stamps rows with it, on the campaign's link(s) to the row set's source ($3), for the campaigns
-- the webhook reports on. A tag without a labelled entity is not here; rows.ts prints the tag.
-- Several entities may share a tag (variants of one creative): the smallest label wins, so the
-- name is the same on every run.
SELECT l.campaign_id,
       e.campaign_tag,
       min(e.label) AS label
  FROM external.link_entity e
  JOIN external.campaign_link l ON l.id = e.link_id
  JOIN app.campaign c ON c.id = l.campaign_id
 WHERE c.company_id = $1
   AND ($2::uuid[] IS NULL OR c.id = ANY ($2::uuid[]))
   AND l.source_id = $3
   AND e.level = 'creative'
   AND e.label IS NOT NULL
 GROUP BY l.campaign_id, e.campaign_tag;
