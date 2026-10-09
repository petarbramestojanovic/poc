-- external.validate_event_map_target() checks every target; an existing mapping is left alone.
INSERT INTO external.event_map (link_id, event_name, target_kind, target_id)
SELECT $1, t.event_name, t.target_kind, t.target_id
  FROM unnest($2::text[], $3::text[], $4::text[]) AS t(event_name, target_kind, target_id)
    ON CONFLICT (link_id, event_name) DO NOTHING;
