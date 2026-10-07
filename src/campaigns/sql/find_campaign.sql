-- FOR UPDATE: a platform-id change locks the campaign first and its link second, like a push.
SELECT id, company_id, name, primary_source, timezone, languages, starts_on, ends_on, status,
       price, currency, external_system, external_id, created_at, updated_at
  FROM app.campaign
 WHERE id = $1
   FOR UPDATE;
