-- Replace semantics: total_count is the event's count over the window of the MOST RECENT run
-- that saw it, not a running sum. The nightly job re-pulls the same days every night; adding
-- would measure how often we synced, not how often the event fired.
INSERT INTO external.unmapped_event (link_id, event_name, first_seen, last_seen, total_count)
SELECT $1, u.event_name, u.first_seen, u.last_seen, u.total_count
  FROM unnest($2::text[], $3::date[], $4::date[], $5::bigint[])
       AS u(event_name, first_seen, last_seen, total_count)
ON CONFLICT (link_id, event_name) DO UPDATE
   SET first_seen = LEAST(external.unmapped_event.first_seen, EXCLUDED.first_seen),
       last_seen = GREATEST(external.unmapped_event.last_seen, EXCLUDED.last_seen),
       total_count = EXCLUDED.total_count
