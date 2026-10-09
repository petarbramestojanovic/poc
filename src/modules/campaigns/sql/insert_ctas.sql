-- Definitions a link needs before it can write clicks. An existing CTA is left exactly as it is.
INSERT INTO analytics.cta (campaign_id, cta_id, name, url, is_internal_event, sort_order)
SELECT $1, t.cta_id, t.name, t.url, t.is_internal_event, t.sort_order
  FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::int[])
       AS t(cta_id, name, url, is_internal_event, sort_order)
    ON CONFLICT (campaign_id, cta_id) DO NOTHING;
