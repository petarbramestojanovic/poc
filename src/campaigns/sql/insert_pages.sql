INSERT INTO analytics.page (campaign_id, page_id, name, sort_order)
SELECT $1, t.page_id, t.name, t.sort_order
  FROM unnest($2::text[], $3::text[], $4::int[]) AS t(page_id, name, sort_order)
    ON CONFLICT (campaign_id, page_id) DO NOTHING;
