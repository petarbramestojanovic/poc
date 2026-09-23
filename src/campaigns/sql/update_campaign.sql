-- Every editable column, already merged by the caller: what it did not change it passes back.
UPDATE app.campaign
   SET name = $2,
       primary_source = $3,
       timezone = $4,
       languages = $5::text[],
       starts_on = $6::date,
       ends_on = $7::date,
       status = $8,
       price = $9::numeric,
       currency = $10,
       updated_at = now()
 WHERE id = $1
RETURNING id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
          price, currency, external_system, external_id, created_at, updated_at;
