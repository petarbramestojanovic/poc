-- The platform ids a link has now: a person's edit is compared against them before anything changes,
-- and a rebuilt link gives the same ids back to the creatives they pointed at.
SELECT level, external_id, role, label, campaign_tag, creative_id
  FROM external.link_entity
 WHERE link_id = $1;
