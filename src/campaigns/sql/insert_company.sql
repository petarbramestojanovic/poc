INSERT INTO app.company (name, external_system, external_id)
VALUES ($1, $2, $3)
RETURNING id, name, external_system, external_id;
