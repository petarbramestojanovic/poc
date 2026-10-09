-- Credentials by id or name (names are unique per source only), optionally for one source, with
-- that source's day zone for connection probes. A NULL filter matches everything.
SELECT c.id, c.name, c.source_id, c.secret_env_var, c.account_scope, c.enabled, s.day_timezone
  FROM external.credential c
  JOIN external.source s ON s.id = c.source_id
 WHERE ($1::text IS NULL OR c.id::text = $1 OR c.name = $1)
   AND ($2::text IS NULL OR c.source_id = $2)
 ORDER BY c.source_id, c.name
