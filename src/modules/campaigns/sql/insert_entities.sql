-- Adds the ids the link does not have yet. One it already has is never touched: changing a tag
-- would split the campaign's rows, and a push only ever adds.
INSERT INTO external.link_entity (link_id, source_id, level, external_id, role, label, campaign_tag)
SELECT $1, $2, t.level, t.external_id, t.role, t.label, t.campaign_tag
  FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
       AS t(level, external_id, role, label, campaign_tag)
    ON CONFLICT (link_id, level, external_id) DO NOTHING
RETURNING level, external_id;
