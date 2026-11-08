-- Everything the platforms created for a campaign so far, oldest first.
SELECT source_id, kind, external_id, creative_id
  FROM external.provisioned_resource
 WHERE campaign_id = $1
 ORDER BY created_at, id;
