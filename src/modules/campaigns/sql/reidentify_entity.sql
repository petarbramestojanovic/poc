-- The same creative under a new platform id: only the id changes, the tag and the creative stay,
-- so every analytics row written so far keeps its owner (validate_entity_creative still checks).
-- Refused by the unique index when the new id belongs to another campaign.
UPDATE external.link_entity
   SET external_id = $4
 WHERE link_id = $1 AND level = $2 AND external_id = $3
RETURNING external_id;
