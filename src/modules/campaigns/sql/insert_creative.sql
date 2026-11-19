-- One creative of a campaign. The tag is the creative's own id unless the caller keys it ($2):
-- the id is minted here so the tag can be it before the row exists. created_at is the wall clock,
-- not the transaction's start, so creatives made in one transaction keep the order they were made
-- in (list_creatives.sql orders by it).
WITH minted AS (SELECT gen_random_uuid() AS id)
INSERT INTO app.creative (id, campaign_id, tag, type, name, created_at)
SELECT minted.id, $1, coalesce($2, minted.id::text), $3, $4, clock_timestamp()
  FROM minted
RETURNING id, campaign_id, tag, type, name, created_at, updated_at;
