-- The platform ids a link has now: a person's edit is compared against them before anything changes.
SELECT level, external_id, role, label, campaign_tag
  FROM external.link_entity
 WHERE link_id = $1;
