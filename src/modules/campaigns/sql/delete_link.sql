-- Only for a link that has written no analytics rows (link_activity.sql). Its entities, event map,
-- unmapped events, sync state and sync runs (with their raw payloads) go with it, so nothing keeps
-- claiming days for ids that were wrong.
DELETE FROM external.campaign_link WHERE id = $1;
