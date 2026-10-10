-- Every source and the metrics it measures: what a column's formula may read from it.
SELECT s.id AS source_id,
       coalesce(array_agg(sm.metric_id) FILTER (WHERE sm.metric_id IS NOT NULL), '{}'::text[])
         AS metrics
  FROM external.source s
  LEFT JOIN external.source_metric sm ON sm.source_id = s.id
 GROUP BY s.id
 ORDER BY s.id;
