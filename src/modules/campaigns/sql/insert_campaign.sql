-- timezone and status fall back to the column defaults (Europe/Zurich, active) when not given.
-- $22 is the industry the keyword table found, or NULL: industry and industry_source both come
-- from it, so campaign_industry_pair always holds.
INSERT INTO app.campaign
  (company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
   external_system, external_id, price, currency, amount, amount_currency, deal_type, country,
   creative_types, owner_name, manager_external_id, manager_name, external_modified_at,
   industry, industry_source)
VALUES ($1, $2, $3, coalesce($4, 'Europe/Zurich'), $5::text[], $6::date, $7::date,
        coalesce($8, 'active'), $9, $10, $11::numeric, $12, $13::numeric, $14, $15, $16,
        $17::text[], $18, $19, $20, $21::timestamptz,
        $22::text, CASE WHEN $22::text IS NULL THEN NULL ELSE 'map' END)
RETURNING id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
          price, currency, amount, amount_currency, deal_type, country, creative_types, owner_name,
          manager_external_id, manager_name, external_modified_at, industry, industry_source,
          external_system, external_id, created_at, updated_at;
