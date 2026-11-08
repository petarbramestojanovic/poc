-- A campaign's creatives, oldest first: the order they were set up in.
SELECT id, campaign_id, tag, type, name, created_at, updated_at
  FROM app.creative
 WHERE campaign_id = $1
 ORDER BY created_at, id;
