-- What a platform created for the campaign (or one creative, $3), as the connector named it.
-- Written right after each step, so a run that fails later resumes from here. A thing the platform
-- already handed us is ours once (unique per source, kind and id).
INSERT INTO external.provisioned_resource (source_id, campaign_id, creative_id, kind, external_id)
SELECT $1, $2, $3, t.kind, t.external_id
  FROM unnest($4::text[], $5::text[]) AS t(kind, external_id)
    ON CONFLICT (source_id, kind, external_id) DO NOTHING
RETURNING id;
