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
       amount = $11::numeric,
       amount_currency = $12,
       deal_type = $13,
       country = $14,
       creative_types = $15::text[],
       owner_name = $16,
       manager_external_id = $17,
       manager_name = $18,
       external_modified_at = $19::timestamptz,
       updated_at = now()
 WHERE id = $1
RETURNING id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
          price, currency, amount, amount_currency, deal_type, country, creative_types, owner_name,
          manager_external_id, manager_name, external_modified_at, external_system, external_id,
          created_at, updated_at;
