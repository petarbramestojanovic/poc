-- Case-insensitive, so "Rauch" and "rauch" are the same client to a person typing it.
SELECT id, name, external_system, external_id
  FROM app.company
 WHERE lower(name) = lower($1)
 ORDER BY created_at
 LIMIT 1;
