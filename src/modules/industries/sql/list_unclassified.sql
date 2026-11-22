-- The campaigns the backfill classifies, oldest first: those without an industry, and with $1
-- (--reclassify) also those whose industry the keyword table or the LLM set. Never a person's.
SELECT c.id, c.external_id, c.name, co.name AS company_name, c.industry, c.industry_source
  FROM app.campaign c
  JOIN app.company co ON co.id = c.company_id
 WHERE c.industry IS NULL
    OR ($1::boolean AND c.industry_source <> 'manual')
 ORDER BY c.created_at, c.id;
