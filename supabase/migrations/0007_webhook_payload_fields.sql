-- 0007_webhook_payload_fields.sql — what a webhook delivers, and which campaigns a report lists.
--
-- ADDITIVE CHANGE TO AN RFC-004 TABLE, approved by the product owner on 2026-09-29. RFC-004 §4
-- defines app.webhook without this column; docs/RFC-004 is kept verbatim, so this header is the
-- record of the deviation.
--
--   payload_fields   the fields a webhook delivers and the ones it calculates, agreed with the client
--                    and entered by a Brame admin. NULL = the full v1 body, exactly as before.
--                    Shape (validated by the service, src/webhooks/fields.ts, before it is saved):
--                      { "metrics":    ["impressions", …],       which metrics; absent = all measured
--                        "sections":   ["daily", "ctas", …],     which lists; absent = all
--                        "calculated": [{ "name": "cost",
--                                         "formula": "impressions / 1000 * price",
--                                         "source": "zeus", "decimals": 2 }] }
--                    Formulas are parsed and evaluated by the service, never by this database.
--
-- Also replaces the body of app.build_webhook_payload (same signature, so 0006's grants hold): a
-- report lists a campaign only when it is not archived and its flight touches the period, or it
-- has analytics in the period. Until now every campaign the company ever had was listed, finished
-- and archived ones included, each with empty numbers.

ALTER TABLE app.webhook
  ADD COLUMN payload_fields jsonb,
  ADD CONSTRAINT webhook_payload_fields_object
    CHECK (payload_fields IS NULL OR jsonb_typeof(payload_fields) = 'object');

COMMENT ON COLUMN app.webhook.payload_fields IS
  'Fields delivered and calculated (src/webhooks/fields.ts); NULL = the full v1 payload.';

CREATE OR REPLACE FUNCTION app.build_webhook_payload(
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
       -- An archived campaign is gone for the client, whatever it still holds.
       AND c.status <> 'archived'
       -- Listed when its flight touches the period (an unknown date never excludes it), or when
       -- it has numbers in the period anyway: a flight date entered wrong must not hide delivery.
       AND (
             ((c.starts_on IS NULL OR c.starts_on <= p_period_end)
              AND (c.ends_on IS NULL OR c.ends_on >= p_period_start))
          OR EXISTS (SELECT 1 FROM analytics.advanced_analytics a
                      WHERE a.campaign_id = c.id
                        AND a.events_date BETWEEN p_period_start AND p_period_end)
          OR EXISTS (SELECT 1 FROM analytics.cta_clicks k
                      WHERE k.campaign_id = c.id
                        AND k.events_date BETWEEN p_period_start AND p_period_end)
          OR EXISTS (SELECT 1 FROM analytics.page_views v
                      WHERE v.campaign_id = c.id
                        AND v.events_date BETWEEN p_period_start AND p_period_end)
           )
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
