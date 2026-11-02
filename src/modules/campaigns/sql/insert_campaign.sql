-- timezone and status fall back to the column defaults (Europe/Zurich, active) when not given.
INSERT INTO app.campaign
  (company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
   external_system, external_id, price, currency, amount, amount_currency, deal_type, country,
   creative_types, owner_name, manager_external_id, manager_name, external_modified_at)
VALUES ($1, $2, $3, coalesce($4, 'Europe/Zurich'), $5::text[], $6::date, $7::date,
        coalesce($8, 'active'), $9, $10, $11::numeric, $12, $13::numeric, $14, $15, $16,
        $17::text[], $18, $19, $20, $21::timestamptz)
RETURNING id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
          price, currency, amount, amount_currency, deal_type, country, creative_types, owner_name,
          manager_external_id, manager_name, external_modified_at, external_system, external_id,
          created_at, updated_at;
