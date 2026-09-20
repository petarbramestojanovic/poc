-- Campaigns with their company and links, newest first. $1 narrows to one company when not NULL.
SELECT c.id, c.company_id, co.name AS company_name, c.name, c.primary_source, c.timezone,
       c.languages, c.starts_on, c.ends_on, c.status, c.external_system, c.external_id,
       c.created_at, c.updated_at,
       coalesce(
         (SELECT jsonb_agg(
                   jsonb_build_object(
                     'id', l.id,
                     'source', l.source_id,
                     'language', l.language,
                     'enabled', l.enabled,
                     'entities', (SELECT count(*) FROM external.link_entity e WHERE e.link_id = l.id)
                   ) ORDER BY l.source_id, l.language)
            FROM external.campaign_link l
           WHERE l.campaign_id = c.id),
         '[]'::jsonb) AS links
  FROM app.campaign c
  JOIN app.company co ON co.id = c.company_id
 WHERE $1::uuid IS NULL OR c.company_id = $1::uuid
 ORDER BY c.created_at DESC
 LIMIT 500;
