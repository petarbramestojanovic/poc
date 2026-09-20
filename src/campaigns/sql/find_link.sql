SELECT id, credential_id, config
  FROM external.campaign_link
 WHERE campaign_id = $1 AND source_id = $2 AND language = $3
   FOR UPDATE;
