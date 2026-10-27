-- Renames the ids the link already has. A label is descriptive — the name a report prints for the
-- entity's rows — so it may change at any time, unlike the id, role and tag, which key the rows
-- written with them. A NULL in the request leaves the stored label alone: a change never blanks it.
UPDATE external.link_entity e
   SET label = t.label
  FROM unnest($2::text[], $3::text[], $4::text[]) AS t(level, external_id, label)
 WHERE e.link_id = $1
   AND e.level = t.level
   AND e.external_id = t.external_id
   AND t.label IS NOT NULL
   AND e.label IS DISTINCT FROM t.label
RETURNING e.level, e.external_id;
