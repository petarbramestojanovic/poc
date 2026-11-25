-- 0019_utm_daily.sql — visits and conversions a client's page reports, per campaign, day and the
-- values the visitor arrived with (referrer, utm_ and brame_ parameters): the UTM tracker of the old
-- analytics (tailor-made-games, `utm_parameters_analytics`), moved here.
--
-- PHASE 2 WORK, approved by the product owner on 2026-11-24: our own ingestion route (public, no
-- token: POST /pages/event, src/modules/tracking) and the first rows with source = 'brame'.
-- Additive: one new table and two new read functions; nothing existing changes. docs/RFC-002 and
-- RFC-004 are kept verbatim, so this header is the record of where it differs from them:
--
--   * The table is analytics.utm_daily, beside analytics.device_daily (RFC-004 §8 names it
--     utm_parameters_analytics).
--   * A conversion is a count on the row of the visit it came from (`conversions`), not a row with
--     a utm_source_register value as in the old table: conversions are then known by every field,
--     and conversions ÷ visits is a rate.
--   * The unique key holds an MD5 of the nine text fields (`combination_key`) instead of the fields
--     (RFC-002 §6.4): nine values of up to 255 characters can be wider than one btree entry may be
--     (2,704 bytes). A collision would add one combination's counts to another's; only a crafted
--     input finds one, and it could as well post the other combination's values.
--   * source is CHECKed to 'brame' instead of referencing external.source: nothing else writes
--     here, and a foreign key would want an index on a column with one value.
--
-- THE ROWS. One per (campaign, day, source, language, overflow, combination of the nine values).
-- Empty is '' and never NULL, so two visits with the same values always meet on one row, and the
-- service counts with one INSERT … ON CONFLICT DO UPDATE (src/modules/tracking/sql/upsert_event.sql).
--
--   events_date      the day in external.source.day_timezone of 'brame' (Europe/Zurich), worked
--                    out by the service (todayIn), never by the database clock.
--   language         the page's language when its tag says one; '' = not split.
--   referrer         the page the visitor came from, without query string, fragment or user:password.
--   utm_source … utm_term, brame_1 … brame_3
--                    the page URL's parameters as sent: trimmed, control characters removed, at most
--                    255 characters (a longer value is cut by the service and ends in '…').
--   overflow         true on the row that collects, per campaign, day and language, the visits of a
--                    combination first seen after the campaign already had PAGE_COMBINATION_CAP
--                    combinations that day (default 2,000). Its nine values are ''. It keeps the
--                    totals right while a flood of made-up values cannot add rows without end.
--   visits           page loads, reloads included (as the old tracker counted).
--   conversions      conversions the page reported, on the row of the visit that brought the visitor.
--
-- THE FIRST TABLE THE SERVICE INCREMENTS. "Replace, never increment" (CLAUDE.md) stays the rule for
-- what a sync writes: no connector writes here, so this table is not in delete_day.sql,
-- link_activity.sql or analytics.metric.
--
-- No IP address, User-Agent or visitor id is stored, here or anywhere.

CREATE TABLE analytics.utm_daily (
  campaign_id      uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  events_date      date NOT NULL,
  source           text NOT NULL DEFAULT 'brame' CHECK (source = 'brame'),
  language         text NOT NULL DEFAULT '' CHECK (language ~ '^([a-z]{2,3})?$'),
  overflow         boolean NOT NULL DEFAULT false,
  referrer         text NOT NULL DEFAULT '' CHECK (char_length(referrer) <= 255),
  utm_source       text NOT NULL DEFAULT '' CHECK (char_length(utm_source) <= 255),
  utm_medium       text NOT NULL DEFAULT '' CHECK (char_length(utm_medium) <= 255),
  utm_campaign     text NOT NULL DEFAULT '' CHECK (char_length(utm_campaign) <= 255),
  utm_content      text NOT NULL DEFAULT '' CHECK (char_length(utm_content) <= 255),
  utm_term         text NOT NULL DEFAULT '' CHECK (char_length(utm_term) <= 255),
  brame_1          text NOT NULL DEFAULT '' CHECK (char_length(brame_1) <= 255),
  brame_2          text NOT NULL DEFAULT '' CHECK (char_length(brame_2) <= 255),
  brame_3          text NOT NULL DEFAULT '' CHECK (char_length(brame_3) <= 255),
  -- Fields joined with U+001F, a control character the service removes from every value, so two
  -- combinations never join to the same text ('ab' + 'c' is not 'a' + 'bc').
  combination_key  text NOT NULL GENERATED ALWAYS AS (md5(
                     referrer || E'\x1f' || utm_source || E'\x1f' || utm_medium || E'\x1f' ||
                     utm_campaign || E'\x1f' || utm_content || E'\x1f' || utm_term || E'\x1f' ||
                     brame_1 || E'\x1f' || brame_2 || E'\x1f' || brame_3)) STORED,
  visits           bigint NOT NULL DEFAULT 0 CHECK (visits >= 0),
  conversions      bigint NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  CONSTRAINT utm_daily_overflow_has_no_values CHECK (
    NOT overflow OR (referrer = '' AND utm_source = '' AND utm_medium = '' AND utm_campaign = ''
                     AND utm_content = '' AND utm_term = '' AND brame_1 = '' AND brame_2 = ''
                     AND brame_3 = '')
  ),
  -- campaign and day first: every read is one campaign over a range of days, and the cap counts a
  -- campaign's combinations of one day. It also covers the foreign key on campaign_id.
  PRIMARY KEY (campaign_id, events_date, source, language, overflow, combination_key)
);

COMMENT ON TABLE analytics.utm_daily IS
  'Page visits and conversions per campaign, day, language and combination of referrer + utm_ + brame_ values, counted by POST /pages/event.';
COMMENT ON COLUMN analytics.utm_daily.overflow IS
  'Collects the visits of combinations first seen after the day''s cap; its nine values are ''''.';
COMMENT ON COLUMN analytics.utm_daily.combination_key IS
  'MD5 of the nine values, for the primary key; never read.';
COMMENT ON COLUMN analytics.utm_daily.conversions IS
  'Conversions the page reported, on the row of the visit that brought the visitor.';

-- A logged-in reader sees it like the other analytics tables (0006); anon has nothing; only the
-- service writes.
ALTER TABLE analytics.utm_daily ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON analytics.utm_daily TO authenticated;
CREATE POLICY read_authenticated ON analytics.utm_daily FOR SELECT TO authenticated USING (true);

-- --------------------------------------------------------------------------------------------
-- The two read functions of the frontend (analytics-fe). They replace the old tracker's eight read
-- endpoints. They run as the caller (SECURITY INVOKER): a reader may already select the table, so
-- they hand out nothing more. The argument names, the dimension names and the JSON keys are a
-- contract with the frontend: change them with it.
--
-- p_from and p_to are days, both included; NULL leaves that side open. p_language NULL = every
-- language; '' = the rows not split by language. Totals count every visit of the period, those
-- without a value and the overflow rows included; `rows` leave out the empty value, as the old
-- reports did, and come sorted by visits, most first, then by value.
-- --------------------------------------------------------------------------------------------

-- One field: { visits, conversions, rows: [{ value, visits, conversions }] }. p_dimension is one of
-- the nine field names, compared as data and never used as a column name; anything else (NULL
-- included) is refused with 22023.
CREATE FUNCTION analytics.utm_breakdown(
  p_campaign_id uuid,
  p_dimension text,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_language text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_campaign_id IS NULL THEN
    RAISE EXCEPTION 'p_campaign_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_dimension IS NULL OR p_dimension NOT IN (
    'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'brame_1', 'brame_2', 'brame_3'
  ) THEN
    RAISE EXCEPTION 'p_dimension must be one of referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, brame_1, brame_2, brame_3'
      USING ERRCODE = '22023';
  END IF;

  WITH period AS (
    SELECT CASE p_dimension
             WHEN 'referrer'     THEN u.referrer
             WHEN 'utm_source'   THEN u.utm_source
             WHEN 'utm_medium'   THEN u.utm_medium
             WHEN 'utm_campaign' THEN u.utm_campaign
             WHEN 'utm_content'  THEN u.utm_content
             WHEN 'utm_term'     THEN u.utm_term
             WHEN 'brame_1'      THEN u.brame_1
             WHEN 'brame_2'      THEN u.brame_2
             WHEN 'brame_3'      THEN u.brame_3
           END AS value,
           u.visits, u.conversions
      FROM analytics.utm_daily u
     WHERE u.campaign_id = p_campaign_id
       AND (p_from IS NULL OR u.events_date >= p_from)
       AND (p_to IS NULL OR u.events_date <= p_to)
       AND (p_language IS NULL OR u.language = p_language)
  ),
  grouped AS (
    SELECT p.value, sum(p.visits) AS visits, sum(p.conversions) AS conversions
      FROM period p
     WHERE p.value <> ''
     GROUP BY p.value
  )
  SELECT jsonb_build_object(
           'visits', (SELECT coalesce(sum(p.visits), 0) FROM period p),
           'conversions', (SELECT coalesce(sum(p.conversions), 0) FROM period p),
           'rows', coalesce(
             (SELECT jsonb_agg(
                       jsonb_build_object('value', g.value, 'visits', g.visits,
                                          'conversions', g.conversions)
                       ORDER BY g.visits DESC, g.value COLLATE "C")
                FROM grouped g),
             '[]'::jsonb))
    INTO result;
  RETURN result;
END
$$;

COMMENT ON FUNCTION analytics.utm_breakdown IS
  'Visits and conversions of one campaign by one field (referrer, utm_*, brame_*), as { visits, conversions, rows }.';

-- Source and medium together: { visits, conversions, rows: [{ utm_source, utm_medium, visits,
-- conversions }] }, leaving out the visits where both are empty.
CREATE FUNCTION analytics.utm_source_medium(
  p_campaign_id uuid,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_language text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH period AS (
    SELECT u.utm_source, u.utm_medium, u.visits, u.conversions
      FROM analytics.utm_daily u
     WHERE u.campaign_id = p_campaign_id
       AND (p_from IS NULL OR u.events_date >= p_from)
       AND (p_to IS NULL OR u.events_date <= p_to)
       AND (p_language IS NULL OR u.language = p_language)
  ),
  grouped AS (
    SELECT p.utm_source, p.utm_medium, sum(p.visits) AS visits, sum(p.conversions) AS conversions
      FROM period p
     WHERE NOT (p.utm_source = '' AND p.utm_medium = '')
     GROUP BY p.utm_source, p.utm_medium
  )
  SELECT jsonb_build_object(
           'visits', (SELECT coalesce(sum(p.visits), 0) FROM period p),
           'conversions', (SELECT coalesce(sum(p.conversions), 0) FROM period p),
           'rows', coalesce(
             (SELECT jsonb_agg(
                       jsonb_build_object('utm_source', g.utm_source, 'utm_medium', g.utm_medium,
                                          'visits', g.visits, 'conversions', g.conversions)
                       ORDER BY g.visits DESC, g.utm_source COLLATE "C", g.utm_medium COLLATE "C")
                FROM grouped g),
             '[]'::jsonb))
$$;

COMMENT ON FUNCTION analytics.utm_source_medium IS
  'Visits and conversions of one campaign by utm_source and utm_medium together, as { visits, conversions, rows }.';

-- Postgres grants EXECUTE to PUBLIC on every new function: taken back, then given to a reader.
REVOKE EXECUTE ON FUNCTION
  analytics.utm_breakdown(uuid, text, date, date, text),
  analytics.utm_source_medium(uuid, date, date, text)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  analytics.utm_breakdown(uuid, text, date, date, text),
  analytics.utm_source_medium(uuid, date, date, text)
  TO authenticated;
