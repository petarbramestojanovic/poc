-- timezone and status fall back to the column defaults (Europe/Zurich, active) when not given.
INSERT INTO app.campaign
  (company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
   external_system, external_id)
VALUES ($1, $2, $3, coalesce($4, 'Europe/Zurich'), $5::text[], $6::date, $7::date,
        coalesce($8, 'active'), $9, $10)
RETURNING id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
          external_system, external_id, created_at, updated_at;
