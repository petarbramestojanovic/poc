SELECT co.id, co.name, co.external_system, co.external_id,
       (SELECT count(*)::int FROM app.campaign c WHERE c.company_id = co.id) AS campaigns
  FROM app.company co
 ORDER BY lower(co.name), co.created_at
 LIMIT 500;
