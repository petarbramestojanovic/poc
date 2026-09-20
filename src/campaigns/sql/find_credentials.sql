-- The enabled credentials of a source. A setup names one by id or name, or names none while
-- there is exactly one to pick.
SELECT id, name
  FROM external.credential
 WHERE source_id = $1 AND enabled
 ORDER BY name;
