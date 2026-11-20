-- The classifier's write: only while the campaign has no industry, so a value set in the meantime
-- (by a person, or by another classification) is never overwritten. No row = it had one.
UPDATE app.campaign
   SET industry = $2, industry_source = $3, updated_at = now()
 WHERE id = $1 AND industry IS NULL
RETURNING id;
