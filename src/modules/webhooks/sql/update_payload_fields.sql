-- Replaces a webhook's field list; NULL goes back to the full v1 body. Applies from the next
-- delivery built: a queued one keeps the body it was stored with.
UPDATE app.webhook
   SET payload_fields = $2::jsonb, updated_at = now()
 WHERE id = $1
RETURNING company_id, campaign_ids;
