-- Non-internal CTA clicks for the `clicks` formula variable, at every level a body reports: per
-- day and language, per creative (campaign_tag), and for the whole period. GROUPING() tells the
-- levels apart (rightmost argument = lowest bit, 1 = aggregated away). A level with no click row
-- is absent here, and a formula sees null there, never 0.
SELECT k.campaign_id,
       k.source,
       CASE grouping(k.events_date, k.language, k.campaign_tag)
         WHEN 1 THEN 'daily'
         WHEN 6 THEN 'creative'
         ELSE 'total'
       END AS level,
       k.events_date,
       k.language,
       k.campaign_tag,
       sum(k.cta_counter)::text AS clicks
  FROM analytics.cta_clicks k
  JOIN analytics.cta c ON c.campaign_id = k.campaign_id AND c.cta_id = k.cta_id
 WHERE k.campaign_id = ANY ($1::uuid[])
   AND k.source = ANY ($2::text[])
   AND k.events_date BETWEEN $3::date AND $4::date
   AND NOT c.is_internal_event
 GROUP BY k.campaign_id, k.source,
          GROUPING SETS ((k.events_date, k.language), (k.campaign_tag), ());
