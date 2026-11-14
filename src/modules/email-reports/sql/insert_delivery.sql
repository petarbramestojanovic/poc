-- The delivery row and the document it will attach ($6, rendered once with this row's id $1). The
-- schedule sends a period once: a second scheduled row for the same (report, period) conflicts on
-- email_report_delivery_scheduled_period (0011) and nothing is inserted. A manual row ($5 =
-- 'manual') never conflicts: a person may send a period again, as a delivery of its own.
INSERT INTO app.email_report_delivery
  (id, email_report_id, period_start, period_end, trigger, document, content_type)
VALUES ($1, $2, $3::date, $4::date, $5, $6, $7)
    ON CONFLICT (email_report_id, period_start, period_end) WHERE trigger = 'schedule' DO NOTHING
RETURNING id;
