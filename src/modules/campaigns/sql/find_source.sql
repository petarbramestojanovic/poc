SELECT id, kind, enabled
  FROM external.source
 WHERE id = $1;
