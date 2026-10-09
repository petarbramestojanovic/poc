SELECT event_name, target_kind, target_id
  FROM external.event_map
 WHERE link_id = $1
 ORDER BY event_name
