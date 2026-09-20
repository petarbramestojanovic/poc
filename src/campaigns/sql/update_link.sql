UPDATE external.campaign_link
   SET credential_id = $2, config = $3::jsonb, updated_at = now()
 WHERE id = $1;
