-- Never the secret: it is shown once, when the webhook is created.
SELECT w.id, w.company_id, co.name AS company_name, w.name, w.url, w.campaign_ids,
       w.schedule_cron, w.timezone, w.report_window, w.include_check_sources,
       w.include_creatives, w.enabled, w.next_run_at, w.created_at, w.payload_fields,
       (SELECT jsonb_build_object(
                 'id', d.id,
                 'status', d.status,
                 'periodStart', d.period_start,
                 'periodEnd', d.period_end,
                 'attempts', d.attempts,
                 'responseCode', d.response_code)
          FROM app.webhook_delivery d
         WHERE d.webhook_id = w.id
         ORDER BY d.created_at DESC
         LIMIT 1) AS last_delivery
  FROM app.webhook w
  JOIN app.company co ON co.id = w.company_id
 WHERE $1::uuid IS NULL OR w.id = $1::uuid
 ORDER BY w.created_at DESC
 LIMIT 500;
