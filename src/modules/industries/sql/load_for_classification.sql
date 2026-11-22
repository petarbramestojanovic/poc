-- What classifying a campaign reads: the names the keyword table and the LLM go by, the country the
-- LLM is told, and what the campaign has now.
SELECT c.id, c.name, c.country, c.industry, c.industry_source, co.name AS company_name
  FROM app.campaign c
  JOIN app.company co ON co.id = c.company_id
 WHERE c.id = $1;
