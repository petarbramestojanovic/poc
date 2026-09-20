UPDATE app.company
   SET name = $2, updated_at = now()
 WHERE id = $1
RETURNING id, name, external_system, external_id;
