-- FOR UPDATE: an edit reads the row, merges the patch and writes it back in one transaction.
SELECT id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
       price, currency, external_system, external_id, created_at, updated_at
  FROM app.campaign
 WHERE id = $1
   FOR UPDATE;
