-- What the platforms created for a campaign and handed ids back for (migration 0011), oldest
-- first. Read by the connectors that derive the ids another platform must be told.
SELECT source_id, kind, external_id, creative_id
  FROM external.provisioned_resource
 WHERE campaign_id = $1
 ORDER BY created_at, id;
