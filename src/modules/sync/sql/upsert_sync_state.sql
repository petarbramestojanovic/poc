-- Committed only after every day's analytics write has committed.
INSERT INTO external.sync_state (link_id, cursor, data_complete_through, last_synced_at, last_deep_sync_at)
VALUES ($1, $2::jsonb, $3, now(), CASE WHEN $4 THEN now() END)
ON CONFLICT (link_id) DO UPDATE
   SET cursor = EXCLUDED.cursor,
       data_complete_through = GREATEST(external.sync_state.data_complete_through, EXCLUDED.data_complete_through),
       last_synced_at = EXCLUDED.last_synced_at,
       last_deep_sync_at = COALESCE(EXCLUDED.last_deep_sync_at, external.sync_state.last_deep_sync_at)
