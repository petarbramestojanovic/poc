INSERT INTO external.raw_payload (sync_run_id, request, response, fetched_at)
SELECT $1, r.request, r.response, r.fetched_at
  FROM unnest($2::jsonb[], $3::jsonb[], $4::timestamptz[]) AS r(request, response, fetched_at)
