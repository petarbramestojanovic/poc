INSERT INTO external.campaign_link (campaign_id, source_id, credential_id, language, config)
VALUES ($1, $2, $3, $4, $5::jsonb)
RETURNING id;
