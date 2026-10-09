-- The caller holds the setup lock for this reference, so the row cannot appear underneath it.
SELECT id, name, external_system, external_id
  FROM app.company
 WHERE external_system = $1 AND external_id = $2;
