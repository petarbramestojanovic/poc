-- The platforms a campaign has ids for, for presets.ts headlineSource.
SELECT DISTINCT source_id
  FROM external.campaign_link
 WHERE campaign_id = $1
 ORDER BY source_id;
