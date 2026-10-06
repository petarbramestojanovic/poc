-- The CPM of each campaign in a body, for formulas that use `price`. As text, so it stays exact.
SELECT id, price::text AS price, currency
  FROM app.campaign
 WHERE id = ANY ($1::uuid[]);
