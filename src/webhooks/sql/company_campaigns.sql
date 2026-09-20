-- Does the company exist, and which of the wanted campaigns are really its own. A webhook reports
-- across one company; a campaign of another company must never be attached to it.
SELECT co.id AS company_id,
       coalesce(
         (SELECT array_agg(c.id)
            FROM app.campaign c
           WHERE c.company_id = co.id AND c.id = ANY ($2::uuid[])),
         '{}'::uuid[]) AS owned
  FROM app.company co
 WHERE co.id = $1;
