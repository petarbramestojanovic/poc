SELECT id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
       price, currency, amount, amount_currency, deal_type, country, creative_types, owner_name,
       manager_external_id, manager_name, external_modified_at, external_system, external_id,
       created_at, updated_at
  FROM app.campaign
 WHERE external_system = $1 AND external_id = $2
   FOR UPDATE;
