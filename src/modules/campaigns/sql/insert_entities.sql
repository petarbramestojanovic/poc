-- Adds the ids the link does not have yet. One it already has is never touched: changing a tag
-- would split the campaign's rows, and a push only ever adds. An entity with a tag points at the
-- creative whose tag it is ($8); the trigger validate_entity_creative holds the two together.
INSERT INTO external.link_entity (link_id, source_id, level, external_id, role, label, campaign_tag, creative_id)
SELECT $1, $2, t.level, t.external_id, t.role, t.label, t.campaign_tag, t.creative_id
  FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::uuid[])
       AS t(level, external_id, role, label, campaign_tag, creative_id)
    ON CONFLICT (link_id, level, external_id) DO NOTHING
RETURNING level, external_id;
