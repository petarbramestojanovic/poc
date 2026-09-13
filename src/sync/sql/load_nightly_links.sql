-- Candidates for the nightly pass: enabled links on enabled credentials and enabled platform
-- sources. Campaign status and dates come along so src/sync/nightly.ts can apply its skip rules
-- with an injected clock. Ordered by credential, so each credential's lane runs in a stable order.
SELECT l.id AS link_id, l.source_id, l.credential_id, l.campaign_id,
       ca.name AS campaign_name, ca.status AS campaign_status, ca.starts_on, ca.ends_on,
       s.day_timezone, s.lookback_days, s.deep_lookback_days
  FROM external.campaign_link l
  JOIN external.credential c ON c.id = l.credential_id
  JOIN external.source s ON s.id = l.source_id
  JOIN app.campaign ca ON ca.id = l.campaign_id
 WHERE l.enabled AND c.enabled AND s.enabled AND s.kind = 'platform'
 ORDER BY l.credential_id, ca.name, l.id
