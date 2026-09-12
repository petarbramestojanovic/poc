INSERT INTO external.unmapped_event (link_id, event_name, first_seen, last_seen, total_count)
SELECT $1, t.event_name, $2, $2, t.count
  FROM unnest($3::text[], $4::bigint[]) AS t(event_name, count)
ON CONFLICT (link_id, event_name) DO UPDATE
   SET first_seen = LEAST(external.unmapped_event.first_seen, EXCLUDED.first_seen),
       last_seen = GREATEST(external.unmapped_event.last_seen, EXCLUDED.last_seen),
       total_count = external.unmapped_event.total_count + EXCLUDED.total_count
