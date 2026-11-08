-- A creative is named by the label of its own entity. When a person relabels that entity
-- (update_entity_labels.sql), the name a report prints follows. Only the creative's own entities
-- rename it, never a pixel that counts for it.
UPDATE app.creative c
   SET name = e.label
  FROM external.link_entity e
 WHERE e.link_id = $1
   AND e.level = 'creative'
   AND e.creative_id = c.id
   AND e.label IS NOT NULL
   AND c.name <> e.label
RETURNING c.id;
