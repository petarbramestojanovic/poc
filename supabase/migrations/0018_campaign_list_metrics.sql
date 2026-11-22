-- 0018_campaign_list_metrics.sql — the campaign list carries each campaign's numbers, its delivery
-- against the planned impressions, and the deal's country and owner. Functions only: no table,
-- column, key, index or grant on a table changes.
--
-- PHASE 2 WORK THAT HANDS A READER MORE THAN 0017, approved by the product owner on 2026-11-22.
-- docs/RFC-004 is kept verbatim, so this header is the record. Approved consequences:
--
--   * Planned impressions come from the closed deal column `amount` (amount ÷ price × 1000).
--     `price` is readable, so planned impressions × price ÷ 1000 gives the deal amount back:
--     every logged-in user can work out a campaign's deal amount.
--   * `country` and `owner_name` (the Salesforce opportunity owner: the sales person), which 0010
--     keeps closed, leave the list function as two columns and its two filters, and the filter
--     options as two lists.
--   * `amount`, `amount_currency`, `deal_type`, `creative_types` and `external_modified_at` still
--     never leave these functions. No grant on a table changes: a reader still cannot select any
--     of these columns, nor country or owner_name.
--
-- Not additive in one respect, approved with it: analytics.list_campaigns is dropped and created
-- again with four more arguments. Adding arguments with CREATE OR REPLACE would make a second
-- function beside the first, and two functions of one name make the frontend's call by argument
-- names ambiguous. Every argument, default, JSON key and sort name of 0017 stays as it was; the
-- new arguments come last. SECURITY DEFINER, the empty search_path and the grants are as in 0017.
--
-- THE NUMBERS. Every one comes from the campaign's primary_source only: never another source, never
-- added across sources. Absent is not zero: a number is null when the source does not measure it or
-- has no row for it, and 0 only when the source measured 0. Nothing here turns null into 0.
--
--   impressions, viewable_impressions, engagements
--       sums of impressions, in_view and game_started in analytics.advanced_analytics over every
--       language and creative tag: a report's campaign-level row (src/modules/webhooks/rows.ts).
--   clicks
--       the sum of cta_counter of the CTAs that are not internal events, as
--       src/modules/webhooks/sql/report_clicks.sql counts them.
--   engagement_rate, ctr, viewability
--       engagements, clicks and viewable impressions ÷ impressions. Never clamped: Zeus can report
--       more clicks or viewable impressions than impressions.
--   desktop_impressions, mobile_impressions (mobile + tablet), desktop_share, mobile_share
--       from analytics.device_daily; a share divides by every device row's impressions, unknown
--       included, so the two can add up to less than 1. A device without a row is null.
--   planned_impressions
--       amount ÷ price × 1000, rounded to a whole impression; null without an amount or a price,
--       with a price of 0, or when amount_currency is not the price's currency.
--   delivered_impressions, delivery
--       the impressions of every day on record, and that ÷ planned_impressions. Always the whole
--       campaign: p_from and p_to never touch them. Over-delivery stays above 1.
--
-- p_from and p_to (inclusive, against events_date, the source's own day; NULL = open on that side)
-- set what the numbers cover and nothing else: never which campaigns match, nor `total`.
--
-- Rounding: a rate is rounded once to 4 decimals, planned impressions to a whole number, half away
-- from zero (Postgres's round of a numeric). The division is numeric, never float, and carries at
-- least 16 significant digits, so its one rounding lands where the exact quotient would for any
-- count or price a campaign has.
--
-- Cost: sorting by a number needs that number for every matching campaign before the page is cut;
-- any other order cuts the page first and works out the numbers of its campaigns only. Each sum is
-- one GROUP BY over the campaigns that need it, through the primary keys of advanced_analytics,
-- cta_clicks and device_daily (campaign_id, source, …), so no index is added.

DROP FUNCTION analytics.list_campaigns(
  text, text, uuid[], text[], text[], text[], date, date, text, boolean, integer, integer
);

-- --------------------------------------------------------------------------------------------
-- 1. analytics.list_campaigns: one page of campaigns, with their numbers, and how many match.
--
--    The arguments of 0017 keep their meaning (see 0017_campaign_list_functions.sql). New:
--
--    p_from, p_to    the days the numbers cover, both included; NULL = no bound on that side.
--    p_countries     campaigns whose country is any of these.
--    p_owners        campaigns whose owner_name is any of these.
--
--    New sort names: impressions | viewable_impressions | engagements | engagement_rate | clicks |
--    ctr | viewability | desktop_share | planned_impressions | delivery | country | owner_name,
--    under the rules of 0017: text without regard to case, NULLs last in both directions, every
--    order ending with created_at DESC, id.
-- --------------------------------------------------------------------------------------------

CREATE FUNCTION analytics.list_campaigns(
  p_search       text    DEFAULT NULL,
  p_status       text    DEFAULT NULL,
  p_company_ids  uuid[]  DEFAULT NULL,
  p_industries   text[]  DEFAULT NULL,
  p_managers     text[]  DEFAULT NULL,
  p_sources      text[]  DEFAULT NULL,
  p_flight_from  date    DEFAULT NULL,
  p_flight_to    date    DEFAULT NULL,
  p_sort         text    DEFAULT NULL,
  p_sort_desc    boolean DEFAULT false,
  p_limit        integer DEFAULT 10,
  p_offset       integer DEFAULT 0,
  p_from         date    DEFAULT NULL,
  p_to           date    DEFAULT NULL,
  p_countries    text[]  DEFAULT NULL,
  p_owners       text[]  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH matching AS (
    SELECT c.id, c.company_id, co.name AS company_name, c.name, c.status, c.primary_source,
           ARRAY(SELECT DISTINCT l.source_id
                   FROM external.campaign_link l
                  WHERE l.campaign_id = c.id
                  ORDER BY l.source_id) AS sources,
           c.languages, c.starts_on, c.ends_on, c.price, c.currency, c.manager_name,
           c.industry, c.industry_source, c.created_at, c.updated_at, c.country, c.owner_name,
           -- The amount never leaves: only the impressions it buys at the price.
           CASE WHEN c.amount_currency = c.currency
                THEN round(c.amount * 1000 / nullif(c.price, 0))
           END AS planned_impressions
      FROM app.campaign c
      JOIN app.company co ON co.id = c.company_id
     WHERE (p_status      IS NULL OR c.status = p_status)
       AND (p_company_ids IS NULL OR c.company_id = ANY (p_company_ids))
       AND (p_industries  IS NULL OR c.industry = ANY (p_industries))
       AND (p_managers    IS NULL OR c.manager_name = ANY (p_managers))
       AND (p_countries   IS NULL OR c.country = ANY (p_countries))
       AND (p_owners      IS NULL OR c.owner_name = ANY (p_owners))
       AND (p_sources     IS NULL OR EXISTS (
              SELECT 1
                FROM external.campaign_link l
               WHERE l.campaign_id = c.id AND l.source_id = ANY (p_sources)))
       AND (p_flight_to   IS NULL OR c.starts_on <= p_flight_to)
       AND (p_flight_from IS NULL OR c.ends_on IS NULL OR c.ends_on >= p_flight_from)
       AND ((p_flight_from IS NULL AND p_flight_to IS NULL)
            OR c.starts_on IS NOT NULL OR c.ends_on IS NOT NULL)
       -- No word of the search is missing. The fields are joined by a space, which no word
       -- contains, so a word never matches across two of them.
       AND NOT EXISTS (
             SELECT 1
               FROM regexp_split_to_table(coalesce(p_search, ''), '\s+') AS word
              WHERE word <> ''
                AND position(lower(word) IN
                      lower(concat_ws(' ', c.name, co.name, c.manager_name))) = 0)
  ),
  -- Whether the order depends on numbers that are summed from the analytics tables.
  by_number AS (
    SELECT coalesce(p_sort = ANY (ARRAY[
             'impressions', 'viewable_impressions', 'engagements', 'engagement_rate', 'clicks',
             'ctr', 'viewability', 'desktop_share', 'delivery']), false) AS yes
  ),
  -- The sort column as one text key or one number key, for the sort names that need no sums;
  -- both NULL otherwise, which leaves the tie-breaker: newest first.
  keyed AS (
    SELECT m.*,
           CASE p_sort
             WHEN 'name'           THEN lower(m.name)
             WHEN 'company_name'   THEN lower(m.company_name)
             WHEN 'industry'       THEN lower(m.industry)
             WHEN 'manager_name'   THEN lower(m.manager_name)
             WHEN 'primary_source' THEN lower(m.primary_source)
             WHEN 'country'        THEN lower(m.country)
             WHEN 'owner_name'     THEN lower(m.owner_name)
           END AS sort_text,
           CASE p_sort
             WHEN 'price'               THEN m.price
             WHEN 'status'              THEN array_position(ARRAY['draft', 'active', 'archived'], m.status)
             WHEN 'starts_on'           THEN extract(epoch FROM m.starts_on)
             WHEN 'ends_on'             THEN extract(epoch FROM m.ends_on)
             WHEN 'created_at'          THEN extract(epoch FROM m.created_at)
             WHEN 'updated_at'          THEN extract(epoch FROM m.updated_at)
             WHEN 'planned_impressions' THEN m.planned_impressions
           END AS sort_number
      FROM matching m
  ),
  -- Not sorted by a summed number: the page is cut here, before any sum.
  page_first AS (
    SELECT k.id
      FROM keyed k
     WHERE NOT (SELECT yes FROM by_number)
     ORDER BY CASE WHEN NOT coalesce(p_sort_desc, false) THEN k.sort_text   END ASC  NULLS LAST,
              CASE WHEN coalesce(p_sort_desc, false)     THEN k.sort_text   END DESC NULLS LAST,
              CASE WHEN NOT coalesce(p_sort_desc, false) THEN k.sort_number END ASC  NULLS LAST,
              CASE WHEN coalesce(p_sort_desc, false)     THEN k.sort_number END DESC NULLS LAST,
              k.created_at DESC, k.id
    OFFSET greatest(coalesce(p_offset, 0), 0)
     LIMIT least(greatest(coalesce(p_limit, 10), 1), 100)
  ),
  -- The campaigns whose numbers are needed: every matching one when the order depends on them,
  -- else the page's.
  needed AS (
    SELECT k.id, k.primary_source FROM keyed k WHERE (SELECT yes FROM by_number)
    UNION ALL
    SELECT k.id, k.primary_source FROM keyed k JOIN page_first p ON p.id = k.id
  ),
  delivery AS (
    SELECT a.campaign_id,
           sum(a.impressions)  FILTER (WHERE (p_from IS NULL OR a.events_date >= p_from)
                                         AND (p_to   IS NULL OR a.events_date <= p_to)) AS impressions,
           sum(a.in_view)      FILTER (WHERE (p_from IS NULL OR a.events_date >= p_from)
                                         AND (p_to   IS NULL OR a.events_date <= p_to)) AS viewable_impressions,
           sum(a.game_started) FILTER (WHERE (p_from IS NULL OR a.events_date >= p_from)
                                         AND (p_to   IS NULL OR a.events_date <= p_to)) AS engagements,
           sum(a.impressions) AS delivered_impressions
      FROM analytics.advanced_analytics a
      JOIN needed n ON n.id = a.campaign_id AND n.primary_source = a.source
     GROUP BY a.campaign_id
  ),
  clicks AS (
    SELECT k.campaign_id, sum(k.cta_counter) AS clicks
      FROM analytics.cta_clicks k
      JOIN needed n ON n.id = k.campaign_id AND n.primary_source = k.source
      JOIN analytics.cta t ON t.campaign_id = k.campaign_id AND t.cta_id = k.cta_id
     WHERE NOT t.is_internal_event
       AND (p_from IS NULL OR k.events_date >= p_from)
       AND (p_to   IS NULL OR k.events_date <= p_to)
     GROUP BY k.campaign_id
  ),
  devices AS (
    SELECT d.campaign_id,
           sum(d.impressions) FILTER (WHERE d.device_type = 'desktop')              AS desktop_impressions,
           sum(d.impressions) FILTER (WHERE d.device_type IN ('mobile', 'tablet')) AS mobile_impressions,
           sum(d.impressions)                                                      AS device_impressions
      FROM analytics.device_daily d
      JOIN needed n ON n.id = d.campaign_id AND n.primary_source = d.source
     WHERE (p_from IS NULL OR d.events_date >= p_from)
       AND (p_to   IS NULL OR d.events_date <= p_to)
     GROUP BY d.campaign_id
  ),
  numbers AS (
    SELECT k.*,
           dl.impressions, dl.viewable_impressions, dl.engagements, ck.clicks,
           round(dl.engagements          / nullif(dl.impressions, 0), 4)        AS engagement_rate,
           round(ck.clicks               / nullif(dl.impressions, 0), 4)        AS ctr,
           round(dl.viewable_impressions / nullif(dl.impressions, 0), 4)        AS viewability,
           dv.desktop_impressions, dv.mobile_impressions,
           round(dv.desktop_impressions  / nullif(dv.device_impressions, 0), 4) AS desktop_share,
           round(dv.mobile_impressions   / nullif(dv.device_impressions, 0), 4) AS mobile_share,
           dl.delivered_impressions,
           round(dl.delivered_impressions / nullif(k.planned_impressions, 0), 4) AS delivery
      FROM keyed k
      JOIN needed n ON n.id = k.id
      LEFT JOIN delivery dl ON dl.campaign_id = k.id
      LEFT JOIN clicks   ck ON ck.campaign_id = k.id
      LEFT JOIN devices  dv ON dv.campaign_id = k.id
  ),
  ranked AS (
    SELECT n.*,
           row_number() OVER (
             ORDER BY CASE WHEN NOT coalesce(p_sort_desc, false) THEN n.sort_text   END ASC  NULLS LAST,
                      CASE WHEN coalesce(p_sort_desc, false)     THEN n.sort_text   END DESC NULLS LAST,
                      CASE WHEN NOT coalesce(p_sort_desc, false) THEN n.sort_number END ASC  NULLS LAST,
                      CASE WHEN coalesce(p_sort_desc, false)     THEN n.sort_number END DESC NULLS LAST,
                      CASE WHEN NOT coalesce(p_sort_desc, false) THEN n.sort_sum    END ASC  NULLS LAST,
                      CASE WHEN coalesce(p_sort_desc, false)     THEN n.sort_sum    END DESC NULLS LAST,
                      n.created_at DESC, n.id
           ) AS position
      FROM (SELECT nb.*,
                   CASE p_sort
                     WHEN 'impressions'          THEN nb.impressions
                     WHEN 'viewable_impressions' THEN nb.viewable_impressions
                     WHEN 'engagements'          THEN nb.engagements
                     WHEN 'engagement_rate'      THEN nb.engagement_rate
                     WHEN 'clicks'               THEN nb.clicks
                     WHEN 'ctr'                  THEN nb.ctr
                     WHEN 'viewability'          THEN nb.viewability
                     WHEN 'desktop_share'        THEN nb.desktop_share
                     WHEN 'delivery'             THEN nb.delivery
                   END AS sort_sum
              FROM numbers nb) n
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM matching),
    'rows',  coalesce(
               (SELECT jsonb_agg(
                         jsonb_build_object(
                           'id',                    r.id,
                           'company_id',            r.company_id,
                           'company_name',          r.company_name,
                           'name',                  r.name,
                           'status',                r.status,
                           'primary_source',        r.primary_source,
                           'sources',               r.sources,
                           'languages',             r.languages,
                           'starts_on',             r.starts_on,
                           'ends_on',               r.ends_on,
                           'price',                 r.price,
                           'currency',              r.currency,
                           'manager_name',          r.manager_name,
                           'industry',              r.industry,
                           'industry_source',       r.industry_source,
                           'created_at',            r.created_at,
                           'updated_at',            r.updated_at,
                           'country',               r.country,
                           'owner_name',            r.owner_name,
                           'impressions',           r.impressions,
                           'viewable_impressions',  r.viewable_impressions,
                           'engagements',           r.engagements,
                           'clicks',                r.clicks,
                           'engagement_rate',       r.engagement_rate,
                           'ctr',                   r.ctr,
                           'viewability',           r.viewability,
                           'desktop_impressions',   r.desktop_impressions,
                           'mobile_impressions',    r.mobile_impressions,
                           'desktop_share',         r.desktop_share,
                           'mobile_share',          r.mobile_share,
                           'planned_impressions',   r.planned_impressions,
                           'delivered_impressions', r.delivered_impressions,
                           'delivery',              r.delivery)
                         ORDER BY r.position)
                  FROM ranked r
                 -- Sorted by a summed number, every matching campaign is ranked and the page is cut
                 -- here; otherwise `ranked` holds the page cut in page_first, in the same order.
                 WHERE NOT (SELECT yes FROM by_number)
                    OR (r.position >  greatest(coalesce(p_offset, 0), 0)
                        AND r.position <= greatest(coalesce(p_offset, 0), 0)
                                          + least(greatest(coalesce(p_limit, 10), 1), 100))),
               '[]'::jsonb))
$$;

COMMENT ON FUNCTION analytics.list_campaigns IS
  'One page of campaigns, searched, filtered and sorted, with their numbers from the primary source, as { total, rows }. SECURITY DEFINER: the one way a reader gets a company''s name, a campaign''s country and owner, and its planned impressions.';

-- --------------------------------------------------------------------------------------------
-- 2. analytics.list_campaign_filter_options gains `countries` and `owners`, ordered like
--    `managers`: each value once, sorted without regard to case, no null, [] when there is none.
--    Same signature, so its grants stay; they are stated again below all the same.
-- --------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION analytics.list_campaign_filter_options()
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'companies',
      coalesce(
        (SELECT jsonb_agg(jsonb_build_object('id', co.id, 'name', co.name)
                          ORDER BY lower(co.name), co.name, co.id)
           FROM app.company co
          WHERE EXISTS (SELECT 1 FROM app.campaign c WHERE c.company_id = co.id)),
        '[]'::jsonb),
    'industries',
      coalesce(
        (SELECT jsonb_agg(v.industry ORDER BY lower(v.industry), v.industry)
           FROM (SELECT DISTINCT c.industry FROM app.campaign c WHERE c.industry IS NOT NULL) v),
        '[]'::jsonb),
    'managers',
      coalesce(
        (SELECT jsonb_agg(v.manager_name ORDER BY lower(v.manager_name), v.manager_name)
           FROM (SELECT DISTINCT c.manager_name
                   FROM app.campaign c
                  WHERE c.manager_name IS NOT NULL) v),
        '[]'::jsonb),
    'sources',
      coalesce(
        (SELECT jsonb_agg(v.source_id ORDER BY v.source_id)
           FROM (SELECT DISTINCT l.source_id FROM external.campaign_link l) v),
        '[]'::jsonb),
    'countries',
      coalesce(
        (SELECT jsonb_agg(v.country ORDER BY lower(v.country), v.country)
           FROM (SELECT DISTINCT c.country FROM app.campaign c WHERE c.country IS NOT NULL) v),
        '[]'::jsonb),
    'owners',
      coalesce(
        (SELECT jsonb_agg(v.owner_name ORDER BY lower(v.owner_name), v.owner_name)
           FROM (SELECT DISTINCT c.owner_name
                   FROM app.campaign c
                  WHERE c.owner_name IS NOT NULL) v),
        '[]'::jsonb))
$$;

COMMENT ON FUNCTION analytics.list_campaign_filter_options IS
  'The companies, industries, managers, sources, countries and owners the campaign list can be filtered by. SECURITY DEFINER, like analytics.list_campaigns.';

-- --------------------------------------------------------------------------------------------
-- 3. Who may call them: a logged-in reader only, as in 0017. The new list_campaigns starts with
--    EXECUTE granted to PUBLIC, like every new function, so that is taken back first.
-- --------------------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  analytics.list_campaigns(text, text, uuid[], text[], text[], text[], date, date, text, boolean, integer, integer, date, date, text[], text[]),
  analytics.list_campaign_filter_options()
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  analytics.list_campaigns(text, text, uuid[], text[], text[], text[], date, date, text, boolean, integer, integer, date, date, text[], text[]),
  analytics.list_campaign_filter_options()
  TO authenticated;
