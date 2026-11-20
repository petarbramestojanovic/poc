-- A person's choice (PUT /campaigns/:id/industry): a name of app.industry with source 'manual', or
-- NULL to clear both, which leaves the campaign to the classifier again. The foreign key refuses a
-- name app.industry does not have. No row = no such campaign.
UPDATE app.campaign
   SET industry = $2::text,
       industry_source = CASE WHEN $2::text IS NULL THEN NULL ELSE 'manual' END,
       updated_at = now()
 WHERE id = $1
RETURNING id, industry, industry_source;
