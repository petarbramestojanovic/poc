SELECT id, name, external_system, external_id
  FROM app.company
 WHERE id = $1;
