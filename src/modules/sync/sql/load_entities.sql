SELECT level, external_id, role, label, campaign_tag
  FROM external.link_entity
 WHERE link_id = $1
 ORDER BY level, external_id
