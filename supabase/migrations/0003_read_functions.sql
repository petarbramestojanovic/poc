-- 0003_read_functions.sql — RFC-004 §7. Functions only: no table, column or key changes.
--
-- Every read the webhook needs is a Postgres function, and the phase-2 dashboard will call the
-- same ones through supabase.rpc(). The rules that are easy to get wrong live here exactly once:
--
--   * Nothing is ever summed across sources. Every function answers for ONE source, resolved from
--     app.campaign.primary_source when the caller passes NULL.
--   * `none`-aggregation metrics (unique_impressions_reported, unique_clicks_reported) are per-day
--     scalars. They are NULL in any range total, and across creatives they pass through only when
--     exactly one creative reported them.
--   * dwell_avg_ms is averaged weighted by game_started, never summed.
--   * NULL stays NULL. A metric a source does not measure is never coalesced to 0.
--
-- All five data functions take the same (p_campaign_id, p_from, p_to, p_source) signature so the
-- dashboard can call them uniformly. get_source_status shares it and ignores the dates: freshness
-- is a property of the link, not of the reported period.

CREATE FUNCTION analytics.resolve_source(p_campaign_id uuid, p_source text)
RETURNS text
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    p_source,
    (SELECT c.primary_source FROM app.campaign c WHERE c.id = p_campaign_id)
  )
$$;

COMMENT ON FUNCTION analytics.resolve_source IS
  'NULL source means the campaign''s primary source (RFC-003 §4.1).';

-- One row per (events_date, language, campaign_tag), metrics exactly as stored: dwell_avg_ms is a
-- per-day average and is not touched here.
CREATE FUNCTION analytics.get_engagement_daily(
  p_campaign_id uuid,
  p_from date,
  p_to date,
  p_source text DEFAULT NULL
)
RETURNS TABLE (
  events_date date,
  language text,
  campaign_tag text,
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
  SELECT a.events_date, a.language, a.campaign_tag,
         a.impressions, a.in_view, a.game_started, a.game_finished,
         a.interactions, a.hovered, a.in_view_time, a.dwell_time, a.interaction_time,
         a.dwell_avg_ms, a.unique_impressions_reported, a.unique_clicks_reported
    FROM analytics.advanced_analytics a
   WHERE a.campaign_id = p_campaign_id
     AND a.source = analytics.resolve_source(p_campaign_id, p_source)
     AND a.events_date BETWEEN p_from AND p_to
   ORDER BY a.events_date, a.language, a.campaign_tag
$$;

-- Range totals for one source: sums for sum-metrics, a game_started-weighted average for
-- dwell_avg_ms, and NULL for the two `none` metrics, which cannot be added over days.
CREATE FUNCTION analytics.get_engagement_totals(
  p_campaign_id uuid,
  p_from date,
  p_to date,
  p_source text DEFAULT NULL
)
RETURNS TABLE (
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
  SELECT sum(a.impressions)::bigint,
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
           -- No game starts to weight by: fall back to a plain mean rather than losing the value.
           round(avg(a.dwell_avg_ms), 2)
         ),
         NULL::bigint,
         NULL::bigint
    FROM analytics.advanced_analytics a
   WHERE a.campaign_id = p_campaign_id
     AND a.source = analytics.resolve_source(p_campaign_id, p_source)
     AND a.events_date BETWEEN p_from AND p_to
$$;

-- Totals per creative (campaign_tag), labelled from external.link_entity. The unique_* scalars
-- stay NULL here too: two creatives can show the same person.
CREATE FUNCTION analytics.get_creative_breakdown(
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
         (SELECT e.label
            FROM external.link_entity e
            JOIN external.campaign_link l ON l.id = e.link_id
           WHERE l.campaign_id = p_campaign_id
             AND e.source_id = analytics.resolve_source(p_campaign_id, p_source)
             AND e.campaign_tag = a.campaign_tag
             AND e.label IS NOT NULL
           ORDER BY (e.level = 'creative') DESC, e.external_id
           LIMIT 1),
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

CREATE FUNCTION analytics.get_page_views(
  p_campaign_id uuid,
  p_from date,
  p_to date,
  p_source text DEFAULT NULL
)
RETURNS TABLE (page_id text, name text, sort_order int, view_counter bigint)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT p.page_id, p.name, p.sort_order, sum(v.view_counter)::bigint
    FROM analytics.page_views v
    JOIN analytics.page p ON p.campaign_id = v.campaign_id AND p.page_id = v.page_id
   WHERE v.campaign_id = p_campaign_id
     AND v.source = analytics.resolve_source(p_campaign_id, p_source)
     AND v.events_date BETWEEN p_from AND p_to
   GROUP BY p.page_id, p.name, p.sort_order
   ORDER BY p.sort_order NULLS LAST, p.page_id
$$;

CREATE FUNCTION analytics.get_cta_clicks(
  p_campaign_id uuid,
  p_from date,
  p_to date,
  p_source text DEFAULT NULL
)
RETURNS TABLE (
  cta_id text,
  name text,
  is_internal_event boolean,
  sort_order int,
  cta_counter bigint
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT c.cta_id, c.name, c.is_internal_event, c.sort_order, sum(k.cta_counter)::bigint
    FROM analytics.cta_clicks k
    JOIN analytics.cta c ON c.campaign_id = k.campaign_id AND c.cta_id = k.cta_id
   WHERE k.campaign_id = p_campaign_id
     AND k.source = analytics.resolve_source(p_campaign_id, p_source)
     AND k.events_date BETWEEN p_from AND p_to
   GROUP BY c.cta_id, c.name, c.is_internal_event, c.sort_order
   ORDER BY c.sort_order NULLS LAST, c.cta_id
$$;

-- What the source measures and how fresh it is. A campaign split across languages has one link
-- per language: the campaign is complete only through the earliest of them.
CREATE FUNCTION analytics.get_source_status(
  p_campaign_id uuid,
  p_from date,
  p_to date,
  p_source text DEFAULT NULL
)
RETURNS TABLE (
  source text,
  display_name text,
  day_timezone text,
  metrics_available text[],
  data_complete_through date,
  last_synced_at timestamptz
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT s.id, s.display_name, s.day_timezone,
         (SELECT coalesce(array_agg(sm.metric_id ORDER BY sm.metric_id), ARRAY[]::text[])
            FROM external.source_metric sm
           WHERE sm.source_id = s.id),
         min(st.data_complete_through),
         max(st.last_synced_at)
    FROM external.source s
    LEFT JOIN external.campaign_link l
      ON l.source_id = s.id AND l.campaign_id = p_campaign_id
    LEFT JOIN external.sync_state st ON st.link_id = l.id
   WHERE s.id = analytics.resolve_source(p_campaign_id, p_source)
   GROUP BY s.id, s.display_name, s.day_timezone
$$;

-- Keeps only the metrics the source actually measures, so a metric absent from
-- external.source_metric is absent from the JSON rather than present as null.
CREATE FUNCTION app.metrics_json(p_metrics jsonb, p_available text[])
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_object_agg(m.key, m.value), '{}'::jsonb)
    FROM jsonb_each(p_metrics) AS m(key, value)
   WHERE m.key = ANY (p_available)
$$;

-- One source block of the webhook payload (contract v1, docs/WEBHOOK-PAYLOAD-v1.md).
CREATE FUNCTION app.webhook_source_block(
  p_campaign_id uuid,
  p_source text,
  p_role text,
  p_from date,
  p_to date,
  p_include_creatives boolean
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_status    record;
  v_available text[];
  v_totals    jsonb;
  v_daily     jsonb;
  v_creatives jsonb := '[]'::jsonb;
  v_ctas      jsonb := '[]'::jsonb;
  v_pages     jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_status
    FROM analytics.get_source_status(p_campaign_id, p_from, p_to, p_source);
  v_available := coalesce(v_status.metrics_available, ARRAY[]::text[]);

  SELECT app.metrics_json(
           jsonb_build_object(
             'impressions', t.impressions,
             'in_view', t.in_view,
             'game_started', t.game_started,
             'game_finished', t.game_finished,
             'interactions', t.interactions,
             'hovered', t.hovered,
             'in_view_time', t.in_view_time,
             'dwell_time', t.dwell_time,
             'interaction_time', t.interaction_time,
             'dwell_avg_ms', t.dwell_avg_ms,
             'unique_impressions_reported', t.unique_impressions_reported,
             'unique_clicks_reported', t.unique_clicks_reported
           ), v_available)
    INTO v_totals
    FROM analytics.get_engagement_totals(p_campaign_id, p_from, p_to, p_source) t;

  -- One entry per (date, language). Counts add across creatives; dwell is weighted; the per-day
  -- unique scalars pass through only when a single creative reported them.
  SELECT coalesce(jsonb_agg(x.entry ORDER BY x.day, x.lang), '[]'::jsonb)
    INTO v_daily
    FROM (
      SELECT d.events_date AS day, d.language AS lang,
             jsonb_build_object('date', d.events_date, 'language', d.language)
               || app.metrics_json(
                    jsonb_build_object(
                      'impressions', sum(d.impressions)::bigint,
                      'in_view', sum(d.in_view)::bigint,
                      'game_started', sum(d.game_started)::bigint,
                      'game_finished', sum(d.game_finished)::bigint,
                      'interactions', sum(d.interactions)::bigint,
                      'hovered', sum(d.hovered)::bigint,
                      'in_view_time', sum(d.in_view_time)::bigint,
                      'dwell_time', sum(d.dwell_time)::bigint,
                      'interaction_time', sum(d.interaction_time)::bigint,
                      'dwell_avg_ms', coalesce(
                        round(sum(d.dwell_avg_ms * d.game_started) FILTER (WHERE d.dwell_avg_ms IS NOT NULL)
                              / nullif(sum(d.game_started) FILTER (WHERE d.dwell_avg_ms IS NOT NULL), 0), 2),
                        round(avg(d.dwell_avg_ms), 2)),
                      'unique_impressions_reported',
                        CASE WHEN count(d.unique_impressions_reported) = 1
                             THEN max(d.unique_impressions_reported) END,
                      'unique_clicks_reported',
                        CASE WHEN count(d.unique_clicks_reported) = 1
                             THEN max(d.unique_clicks_reported) END
                    ), v_available) AS entry
        FROM analytics.get_engagement_daily(p_campaign_id, p_from, p_to, p_source) d
       GROUP BY d.events_date, d.language
    ) x;

  IF p_include_creatives THEN
    SELECT coalesce(jsonb_agg(
             jsonb_build_object(
               'campaign_tag', b.campaign_tag,
               'label', b.label,
               'totals', app.metrics_json(
                 jsonb_build_object(
                   'impressions', b.impressions,
                   'in_view', b.in_view,
                   'game_started', b.game_started,
                   'game_finished', b.game_finished,
                   'interactions', b.interactions,
                   'hovered', b.hovered,
                   'in_view_time', b.in_view_time,
                   'dwell_time', b.dwell_time,
                   'interaction_time', b.interaction_time,
                   'dwell_avg_ms', b.dwell_avg_ms,
                   'unique_impressions_reported', b.unique_impressions_reported,
                   'unique_clicks_reported', b.unique_clicks_reported
                 ), v_available)
             ) ORDER BY b.campaign_tag), '[]'::jsonb)
      INTO v_creatives
      FROM analytics.get_creative_breakdown(p_campaign_id, p_from, p_to, p_source) b;
  END IF;

  IF 'cta_counter' = ANY (v_available) THEN
    SELECT coalesce(jsonb_agg(
             jsonb_build_object(
               'cta_id', c.cta_id,
               'name', c.name,
               'is_internal_event', c.is_internal_event,
               'count', c.cta_counter
             ) ORDER BY c.sort_order NULLS LAST, c.cta_id), '[]'::jsonb)
      INTO v_ctas
      FROM analytics.get_cta_clicks(p_campaign_id, p_from, p_to, p_source) c;
  END IF;

  IF 'view_counter' = ANY (v_available) THEN
    SELECT coalesce(jsonb_agg(
             jsonb_build_object(
               'page_id', p.page_id,
               'name', p.name,
               'count', p.view_counter
             ) ORDER BY p.sort_order NULLS LAST, p.page_id), '[]'::jsonb)
      INTO v_pages
      FROM analytics.get_page_views(p_campaign_id, p_from, p_to, p_source) p;
  END IF;

  RETURN jsonb_build_object(
    'source', p_source,
    'display_name', v_status.display_name,
    'role', p_role,
    'day_timezone', v_status.day_timezone,
    'data_complete_through', v_status.data_complete_through,
    'last_synced_at',
      CASE WHEN v_status.last_synced_at IS NULL THEN NULL
           ELSE to_char(v_status.last_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
    'metrics_available', to_jsonb(v_available),
    'totals', v_totals,
    'daily', v_daily,
    'creatives', v_creatives,
    'ctas', v_ctas,
    'pages', v_pages
  );
END
$$;

-- The versioned document a client receives (RFC-002 §15.4). The primary source comes first and is
-- labelled 'primary'; every other configured source is a labelled 'check' block, included only
-- when the webhook asks for them. Nothing is added up across those blocks.
CREATE FUNCTION app.build_webhook_payload(
  p_webhook_id uuid,
  p_period_start date,
  p_period_end date
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_webhook   record;
  v_campaign  record;
  v_source    record;
  v_campaigns jsonb := '[]'::jsonb;
  v_sources   jsonb;
BEGIN
  SELECT w.* INTO v_webhook FROM app.webhook w WHERE w.id = p_webhook_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook % does not exist', p_webhook_id USING ERRCODE = 'no_data_found';
  END IF;

  FOR v_campaign IN
    SELECT c.id, c.name, c.primary_source
      FROM app.campaign c
     WHERE c.company_id = v_webhook.company_id
       AND (v_webhook.campaign_ids IS NULL OR c.id = ANY (v_webhook.campaign_ids))
     ORDER BY c.name, c.id
  LOOP
    v_sources := '[]'::jsonb;

    FOR v_source IN
      SELECT s.id,
             CASE WHEN s.id = v_campaign.primary_source THEN 'primary' ELSE 'check' END AS role
        FROM external.source s
       WHERE s.id = v_campaign.primary_source
          OR (v_webhook.include_check_sources
              AND EXISTS (SELECT 1
                            FROM external.campaign_link l
                           WHERE l.campaign_id = v_campaign.id AND l.source_id = s.id))
       ORDER BY (s.id = v_campaign.primary_source) DESC, s.id
    LOOP
      v_sources := v_sources || jsonb_build_array(
        app.webhook_source_block(
          v_campaign.id, v_source.id, v_source.role,
          p_period_start, p_period_end, v_webhook.include_creatives));
    END LOOP;

    v_campaigns := v_campaigns || jsonb_build_array(
      jsonb_build_object(
        'id', v_campaign.id,
        'name', v_campaign.name,
        'primary_source', v_campaign.primary_source,
        'sources', v_sources));
  END LOOP;

  RETURN jsonb_build_object(
    'version', v_webhook.payload_version,
    -- Stamped by the statement that creates the delivery row, so the id a client sees in the
    -- X-Delivery-Id header is the one inside the signed body.
    'delivery_id', NULL,
    'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'period', jsonb_build_object(
      'start', p_period_start,
      'end', p_period_end,
      'timezone', v_webhook.timezone,
      'window', v_webhook.report_window),
    'company', (SELECT jsonb_build_object('id', co.id, 'name', co.name)
                  FROM app.company co WHERE co.id = v_webhook.company_id),
    'campaigns', v_campaigns);
END
$$;
