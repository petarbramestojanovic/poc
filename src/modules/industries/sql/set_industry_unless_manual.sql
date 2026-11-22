-- The backfill's reclassification: redoes what the keyword table or the LLM decided, never what a
-- person set, and writes nothing when the answer is what the campaign already has (updated_at keeps
-- meaning "changed"). No row = kept.
UPDATE app.campaign
   SET industry = $2, industry_source = $3, updated_at = now()
 WHERE id = $1
   AND (industry_source IS NULL OR industry_source <> 'manual')
   AND (industry, industry_source) IS DISTINCT FROM ($2::text, $3::text)
RETURNING id;
