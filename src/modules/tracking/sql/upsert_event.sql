-- One page event: adds $13 visits and $14 conversions to the row of its campaign, day, language and
-- combination of values, creating the row when it is new. One statement, so posts racing for the
-- same new combination make one row and lose no count (INSERT … ON CONFLICT DO UPDATE).
--
--   $1 campaign_id   $2 events_date   $3 language
--   $4 referrer  $5 utm_source  $6 utm_medium  $7 utm_campaign  $8 utm_content  $9 utm_term
--   $10 brame_1  $11 brame_2  $12 brame_3   (TRACKED_FIELDS order; positional, so
--                                              tests/integration/page-tracking.test.ts reads every
--                                              column back by name)
--   $13 visits  $14 conversions  $15 the cap on a campaign's combinations a day
--
-- Nothing is written, and no row comes back, when the campaign does not exist or is archived.
--
-- The cap: a combination the campaign has not had that day, while it already has $15 of them
-- (every language counted), goes to the day's overflow row of its language, whose values are ''.
-- The count is read before the insert, so posts racing at the edge may pass it by one or two;
-- the limit holds the table to a bounded size, not to an exact number. The CASE asks for the count
-- only when the combination is new, and the count stops at $15. `target` is MATERIALIZED: inlined,
-- Postgres would run its two subqueries once for every column that reads target.overflow.
WITH campaign AS (
  SELECT c.id
    FROM app.campaign c
   WHERE c.id = $1::uuid AND c.status <> 'archived'
),
target AS MATERIALIZED (
  SELECT CASE
           WHEN EXISTS (
             SELECT 1
               FROM analytics.utm_daily u
              WHERE u.campaign_id = $1::uuid
                AND u.events_date = $2::date
                AND u.source = 'brame'
                AND u.language = $3::text
                AND NOT u.overflow
                -- The same expression as the generated column combination_key (0019).
                AND u.combination_key = md5(
                      $4::text || E'\x1f' || $5::text || E'\x1f' || $6::text || E'\x1f' ||
                      $7::text || E'\x1f' || $8::text || E'\x1f' || $9::text || E'\x1f' ||
                      $10::text || E'\x1f' || $11::text || E'\x1f' || $12::text)
           ) THEN false
           ELSE (
             SELECT count(*) >= $15::int
               FROM (
                 SELECT 1
                   FROM analytics.utm_daily u
                  WHERE u.campaign_id = $1::uuid
                    AND u.events_date = $2::date
                    AND NOT u.overflow
                  LIMIT $15::int
               ) seen
           )
         END AS overflow
)
INSERT INTO analytics.utm_daily AS d (
  campaign_id, events_date, language, overflow,
  referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, brame_1, brame_2, brame_3,
  visits, conversions
)
SELECT campaign.id, $2::date, $3::text, target.overflow,
       CASE WHEN target.overflow THEN '' ELSE $4::text END,
       CASE WHEN target.overflow THEN '' ELSE $5::text END,
       CASE WHEN target.overflow THEN '' ELSE $6::text END,
       CASE WHEN target.overflow THEN '' ELSE $7::text END,
       CASE WHEN target.overflow THEN '' ELSE $8::text END,
       CASE WHEN target.overflow THEN '' ELSE $9::text END,
       CASE WHEN target.overflow THEN '' ELSE $10::text END,
       CASE WHEN target.overflow THEN '' ELSE $11::text END,
       CASE WHEN target.overflow THEN '' ELSE $12::text END,
       $13::bigint, $14::bigint
  FROM campaign, target
ON CONFLICT (campaign_id, events_date, source, language, overflow, combination_key)
DO UPDATE SET visits = d.visits + EXCLUDED.visits,
              conversions = d.conversions + EXCLUDED.conversions
RETURNING d.overflow
