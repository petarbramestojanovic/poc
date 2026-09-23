-- One campaign with everything that was set up for it.
SELECT c.id, c.company_id, co.name AS company_name, c.name, c.primary_source, c.timezone,
       c.languages, c.starts_on, c.ends_on, c.status, c.price, c.currency, c.external_system,
       c.external_id, c.created_at, c.updated_at,
       coalesce(
         (SELECT jsonb_agg(
                   jsonb_build_object(
                     'id', l.id,
                     'source', l.source_id,
                     'language', l.language,
                     'enabled', l.enabled,
                     'config', l.config,
                     'entities', coalesce(
                       (SELECT jsonb_agg(
                                 jsonb_build_object(
                                   'level', e.level,
                                   'externalId', e.external_id,
                                   'role', e.role,
                                   'label', e.label,
                                   'campaignTag', e.campaign_tag
                                 ) ORDER BY e.level, e.external_id)
                          FROM external.link_entity e
                         WHERE e.link_id = l.id),
                       '[]'::jsonb)
                   ) ORDER BY l.source_id, l.language)
            FROM external.campaign_link l
           WHERE l.campaign_id = c.id),
         '[]'::jsonb) AS links
  FROM app.campaign c
  JOIN app.company co ON co.id = c.company_id
 WHERE c.id = $1;
