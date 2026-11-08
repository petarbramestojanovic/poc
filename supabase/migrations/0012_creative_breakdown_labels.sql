-- 0012_creative_breakdown_labels.sql — the creative breakdown names a creative by its record.
--
-- Additive: replaces the body of analytics.get_creative_breakdown (0003), no table, column or
-- key changes. Since 0011 a creative is a record of ours (app.creative) with one name, and the
-- reports print that name; the console's breakdown did so from the entity's label and so could
-- disagree with a report after a relabel on one platform. It now prints app.creative.name for the
-- tag, and falls back to an entity's label only for a tag no creative owns (rows written before
-- 0011 by an entity since removed).

CREATE OR REPLACE FUNCTION analytics.get_creative_breakdown(
  p_campaign_id uuid,
  p_from date,
  p_to date,
  p_source text DEFAULT NULL
)
RETURNS TABLE (
  campaign_tag text,
  label text,
  impressions bigint,
  in_view bigint,
  game_started bigint,
  game_finished bigint,
  interactions bigint,
  hovered bigint,
  in_view_time bigint,
  dwell_time bigint,
  interaction_time bigint,
  dwell_avg_ms numeric,
  unique_impressions_reported bigint,
  unique_clicks_reported bigint
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT a.campaign_tag,
         coalesce(
           (SELECT c.name FROM app.creative c
             WHERE c.campaign_id = p_campaign_id AND c.tag = a.campaign_tag),
           (SELECT e.label
              FROM external.link_entity e
              JOIN external.campaign_link l ON l.id = e.link_id
             WHERE l.campaign_id = p_campaign_id
               AND e.source_id = analytics.resolve_source(p_campaign_id, p_source)
               AND e.campaign_tag = a.campaign_tag
               AND e.label IS NOT NULL
             ORDER BY (e.level = 'creative') DESC, e.external_id
             LIMIT 1)
         ),
         sum(a.impressions)::bigint,
         sum(a.in_view)::bigint,
         sum(a.game_started)::bigint,
         sum(a.game_finished)::bigint,
         sum(a.interactions)::bigint,
         sum(a.hovered)::bigint,
         sum(a.in_view_time)::bigint,
         sum(a.dwell_time)::bigint,
         sum(a.interaction_time)::bigint,
         coalesce(
           round(sum(a.dwell_avg_ms * a.game_started) FILTER (WHERE a.dwell_avg_ms IS NOT NULL)
                 / nullif(sum(a.game_started) FILTER (WHERE a.dwell_avg_ms IS NOT NULL), 0), 2),
           round(avg(a.dwell_avg_ms), 2)
         ),
         NULL::bigint,
         NULL::bigint
    FROM analytics.advanced_analytics a
   WHERE a.campaign_id = p_campaign_id
     AND a.source = analytics.resolve_source(p_campaign_id, p_source)
     AND a.events_date BETWEEN p_from AND p_to
   GROUP BY a.campaign_tag
   ORDER BY a.campaign_tag
$$;
