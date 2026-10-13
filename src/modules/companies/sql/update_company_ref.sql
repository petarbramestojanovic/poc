-- Moves a company to the reference its system knows it by now (resolveCompany, formerRef). The
-- caller holds the setup locks of both references, so neither row can change underneath it.
UPDATE app.company
   SET external_system = $2, external_id = $3, updated_at = now()
 WHERE id = $1
RETURNING id, name, external_system, external_id;
