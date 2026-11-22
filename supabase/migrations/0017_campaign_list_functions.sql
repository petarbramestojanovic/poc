-- 0017_campaign_list_functions.sql — the campaign list of the frontend. Functions only: no table,
-- column, key or index changes.
--
-- PHASE 2 WORK BROUGHT FORWARD AND AN ADDITION BESIDE RFC-004, approved by the maintainer on
-- 2026-11-22. docs/RFC-004 is kept verbatim, so this header is the record.
--
-- The frontend (analytics-fe: React + supabase-js) signs a user in with Supabase Auth and talks to
-- Supabase only, never to the service. Its campaign table is server-driven: the database searches,
-- filters, sorts and pages, and answers with one page and the total. It calls
--
--   supabase.schema('analytics').rpc('list_campaigns', args)       -- only the arguments that are set
--   supabase.schema('analytics').rpc('list_campaign_filter_options')
--
-- so the argument names, the sort column names and the JSON keys below are a contract with it.
--
-- WHAT A READER GAINS, approved with it: every logged-in user reads every company's campaigns and
-- company names through these two functions, until a user↔company mapping exists. 0006's model is
-- unchanged (every logged-in user reads everything that is granted; sign-ups and anonymous
-- sign-ins stay off).
--
-- SECURITY DEFINER, unlike the read functions of 0003, which run as the caller. A reader has no
-- grant on app.company and must not get one: nothing in `app` beyond `campaign` and `creative` is
-- ever granted. A list needs the company's name, so these functions run as their owner and hand
-- out the name and the id of a company, and nothing else from that table. No grant is added on
-- app.company: a reader still cannot select it. Of app.campaign they return only columns a reader
-- may already select; nothing of the deal that 0010 keeps closed (amount, amount_currency,
-- deal_type, country, creative_types, owner_name, external_modified_at) leaves them.
--
-- Because they run as their owner: `search_path` is empty and every name is schema-qualified, so a
-- caller cannot put an object of its own in the way; the search text is compared with position(),
-- never built into a pattern or a statement; the sort column is matched against a fixed list, never
-- executed. EXECUTE is taken from PUBLIC and given to `authenticated` alone, as in 0006.

-- --------------------------------------------------------------------------------------------
-- 1. analytics.list_campaigns: one page of campaigns and how many match.
--
--    Returns { "total": <matching campaigns, all pages>, "rows": [ … ] }; `rows` is [] for an
--    empty page. Every argument has a default, and NULL means "no restriction"; filters combine
--    with AND. A list argument matches a campaign that has any of its values.
--
--    p_search        every whitespace-separated word must occur, case-insensitively, somewhere in
--                    the campaign name, the company name or the manager name. Literal text: % and
--                    _ are characters. Empty or only whitespace restricts nothing.
--    p_sources       campaigns with a link to any of these sources (not the headline source).
--    p_flight_from,  the flight touches the window: ends_on >= p_flight_from (no ends_on = still
--    p_flight_to     running) and starts_on <= p_flight_to. With either set, a campaign without
--                    both dates does not match.
--    p_sort          name | company_name | status | industry | starts_on | ends_on |
--                    primary_source | price | manager_name | created_at | updated_at. Anything
--                    else, or NULL, is newest first. Text sorts without regard to case, status in
--                    lifecycle order (draft, active, archived), NULLs last in both directions.
--                    Every order ends with created_at DESC, id, so a row never repeats or goes
--                    missing between two pages.
--    p_limit         page size, clamped to 1–100.
--    p_offset        rows to skip; negative is 0.
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
  p_offset       integer DEFAULT 0
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
           c.industry, c.industry_source, c.created_at, c.updated_at
      FROM app.campaign c
      JOIN app.company co ON co.id = c.company_id
     WHERE (p_status      IS NULL OR c.status = p_status)
       AND (p_company_ids IS NULL OR c.company_id = ANY (p_company_ids))
       AND (p_industries  IS NULL OR c.industry = ANY (p_industries))
       AND (p_managers    IS NULL OR c.manager_name = ANY (p_managers))
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
  -- The sort column as one text key or one number key; both NULL for an unknown column, which
  -- leaves the tie-breaker: newest first.
  keyed AS (
    SELECT m.*,
           CASE p_sort
             WHEN 'name'           THEN lower(m.name)
             WHEN 'company_name'   THEN lower(m.company_name)
             WHEN 'industry'       THEN lower(m.industry)
             WHEN 'manager_name'   THEN lower(m.manager_name)
             WHEN 'primary_source' THEN lower(m.primary_source)
           END AS sort_text,
           CASE p_sort
             WHEN 'price'      THEN m.price
             WHEN 'status'     THEN array_position(ARRAY['draft', 'active', 'archived'], m.status)
             WHEN 'starts_on'  THEN extract(epoch FROM m.starts_on)
             WHEN 'ends_on'    THEN extract(epoch FROM m.ends_on)
             WHEN 'created_at' THEN extract(epoch FROM m.created_at)
             WHEN 'updated_at' THEN extract(epoch FROM m.updated_at)
           END AS sort_number
      FROM matching m
  ),
  ranked AS (
    SELECT k.*,
           row_number() OVER (
             ORDER BY CASE WHEN NOT coalesce(p_sort_desc, false) THEN k.sort_text   END ASC  NULLS LAST,
                      CASE WHEN coalesce(p_sort_desc, false)     THEN k.sort_text   END DESC NULLS LAST,
                      CASE WHEN NOT coalesce(p_sort_desc, false) THEN k.sort_number END ASC  NULLS LAST,
                      CASE WHEN coalesce(p_sort_desc, false)     THEN k.sort_number END DESC NULLS LAST,
                      k.created_at DESC, k.id
           ) AS position
      FROM keyed k
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM matching),
    'rows',  coalesce(
               (SELECT jsonb_agg(
                         jsonb_build_object(
                           'id',              r.id,
                           'company_id',      r.company_id,
                           'company_name',    r.company_name,
                           'name',            r.name,
                           'status',          r.status,
                           'primary_source',  r.primary_source,
                           'sources',         r.sources,
                           'languages',       r.languages,
                           'starts_on',       r.starts_on,
                           'ends_on',         r.ends_on,
                           'price',           r.price,
                           'currency',        r.currency,
                           'manager_name',    r.manager_name,
                           'industry',        r.industry,
                           'industry_source', r.industry_source,
                           'created_at',      r.created_at,
                           'updated_at',      r.updated_at)
                         ORDER BY r.position)
                  FROM ranked r
                 WHERE r.position >  greatest(coalesce(p_offset, 0), 0)
                   AND r.position <= greatest(coalesce(p_offset, 0), 0)
                                     + least(greatest(coalesce(p_limit, 10), 1), 100)),
               '[]'::jsonb))
$$;

COMMENT ON FUNCTION analytics.list_campaigns IS
  'One page of campaigns, searched, filtered and sorted, as { total, rows }. SECURITY DEFINER: the one way a reader gets a company''s name.';

-- --------------------------------------------------------------------------------------------
-- 2. analytics.list_campaign_filter_options: the values the list can be filtered by, across all
--    campaigns. Each value once, sorted without regard to case; an empty list is [], never null.
--    Two companies of one name are two entries: a company is its id.
-- --------------------------------------------------------------------------------------------

CREATE FUNCTION analytics.list_campaign_filter_options()
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
        '[]'::jsonb))
$$;

COMMENT ON FUNCTION analytics.list_campaign_filter_options IS
  'The companies, industries, managers and sources the campaign list can be filtered by. SECURITY DEFINER, like analytics.list_campaigns.';

-- --------------------------------------------------------------------------------------------
-- 3. Who may call them. Postgres grants EXECUTE to PUBLIC on every new function; a function that
--    runs as its owner must not keep that. A logged-in reader only: anon has nothing (0006).
-- --------------------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  analytics.list_campaigns(text, text, uuid[], text[], text[], text[], date, date, text, boolean, integer, integer),
  analytics.list_campaign_filter_options()
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  analytics.list_campaigns(text, text, uuid[], text[], text[], text[], date, date, text, boolean, integer, integer),
  analytics.list_campaign_filter_options()
  TO authenticated;
