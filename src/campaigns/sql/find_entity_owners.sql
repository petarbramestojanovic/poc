-- Which of these platform ids already belong to ANOTHER link. external.link_entity allows an
-- external entity in one campaign only; this names the owner so the refusal can say who has it.
SELECT e.level, e.external_id, c.id AS campaign_id, c.name AS campaign_name
  FROM unnest($3::text[], $4::text[]) AS wanted(level, external_id)
  JOIN external.link_entity e
    ON e.source_id = $1 AND e.level = wanted.level AND e.external_id = wanted.external_id
  JOIN external.campaign_link l ON l.id = e.link_id
  JOIN app.campaign c ON c.id = l.campaign_id
 WHERE e.link_id <> $2;
