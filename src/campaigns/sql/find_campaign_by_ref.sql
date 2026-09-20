SELECT id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
       external_system, external_id, created_at, updated_at
  FROM app.campaign
 WHERE external_system = $1 AND external_id = $2
   FOR UPDATE;
