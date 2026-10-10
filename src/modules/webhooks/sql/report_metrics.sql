-- Every stored row of the webhook's source ($3) in the period, per campaign, language, creative
-- and day, for the campaigns the webhook reports on: never an archived one, and $2 NULL = every
-- campaign of the company. build.ts reads each metric column back by its name; NULL = the source
-- does not measure it. A day without a row here has no report row.
SELECT a.campaign_id,
       c.name AS campaign,
       c.price::text AS price,
       a.events_date,
       a.language,
       a.campaign_tag,
       a.impressions,
       a.in_view,
       a.game_started,
       a.game_finished,
       a.interactions,
       a.hovered,
       a.in_view_time,
       a.dwell_time,
       a.interaction_time,
       a.dwell_avg_ms,
       a.unique_impressions_reported,
       a.unique_clicks_reported
  FROM analytics.advanced_analytics a
  JOIN app.campaign c ON c.id = a.campaign_id
 WHERE c.company_id = $1
   AND ($2::uuid[] IS NULL OR c.id = ANY ($2::uuid[]))
   AND c.status <> 'archived'
   AND a.source = $3
   AND a.events_date BETWEEN $4::date AND $5::date;
