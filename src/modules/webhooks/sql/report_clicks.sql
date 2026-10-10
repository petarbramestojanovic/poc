-- Non-internal CTA clicks for the `clicks` formula variable: one campaign on one day, every
-- language, creative and CTA together, in the webhook's source ($3). Same campaigns as
-- report_metrics.sql. A day without a click row is absent here, and a formula sees null, never 0.
SELECT k.campaign_id,
       c.name AS campaign,
       c.price::text AS price,
       k.events_date,
       sum(k.cta_counter)::text AS clicks
  FROM analytics.cta_clicks k
  JOIN analytics.cta t ON t.campaign_id = k.campaign_id AND t.cta_id = k.cta_id
  JOIN app.campaign c ON c.id = k.campaign_id
 WHERE c.company_id = $1
   AND ($2::uuid[] IS NULL OR c.id = ANY ($2::uuid[]))
   AND c.status <> 'archived'
   AND k.source = $3
   AND k.events_date BETWEEN $4::date AND $5::date
   AND NOT t.is_internal_event
 GROUP BY k.campaign_id, c.name, c.price, k.events_date;
