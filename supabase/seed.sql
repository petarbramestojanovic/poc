-- Local development fixtures only (applied by `supabase db reset`). Never run against dev or prod.
-- One company, one campaign (primary_source = 'zeus'), one credential per platform,
-- one link per platform with two entities each, plus the pages/CTAs the NEXD event map points at.

INSERT INTO app.company (id, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Dev Company');

INSERT INTO app.campaign (id, company_id, name, primary_source, languages, starts_on, ends_on) VALUES
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   'DEV0001 Dev Campaign', 'zeus', '{de}', '2026-09-01', '2026-10-31');

INSERT INTO analytics.page (campaign_id, page_id, name, sort_order) VALUES
  ('00000000-0000-4000-8000-000000000002', 'main',   'Main',   1),
  ('00000000-0000-4000-8000-000000000002', 'result', 'Result', 2);

INSERT INTO analytics.cta (campaign_id, cta_id, name, url, is_internal_event, sort_order) VALUES
  ('00000000-0000-4000-8000-000000000002', 'clickthrough', 'Click-out', 'https://example.com/shop', false, 1);

INSERT INTO external.credential (id, source_id, name, secret_env_var) VALUES
  ('00000000-0000-4000-8000-000000000011', 'nexd', 'nexd-main', 'NEXD_API_KEY'),
  ('00000000-0000-4000-8000-000000000012', 'zeus', 'zeus-main', 'ZEUS_API_TOKEN');

INSERT INTO external.campaign_link (id, campaign_id, source_id, credential_id, language, config) VALUES
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000002', 'nexd',
   '00000000-0000-4000-8000-000000000011', 'de', '{}'),
  ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000002', 'zeus',
   '00000000-0000-4000-8000-000000000012', 'de', '{"clickthrough_cta_id": "clickthrough"}');

INSERT INTO external.link_entity (link_id, source_id, level, external_id, role, label, campaign_tag) VALUES
  ('00000000-0000-4000-8000-000000000021', 'nexd', 'creative', 'nx_dev_v1', NULL,         'Dev creative V1',      'nx_dev_v1'),
  ('00000000-0000-4000-8000-000000000021', 'nexd', 'creative', 'nx_dev_v2', NULL,         'Dev creative V2',      'nx_dev_v2'),
  ('00000000-0000-4000-8000-000000000022', 'zeus', 'creative', '12345',     NULL,         'Dev MPU V1',           'mpu_v1'),
  ('00000000-0000-4000-8000-000000000022', 'zeus', 'pixel',    'dev1eng',   'engagement', 'Dev engagement pixel', 'mpu_v1');

INSERT INTO external.event_map (link_id, event_name, target_kind, target_id) VALUES
  ('00000000-0000-4000-8000-000000000021', 'Unique [Touch]',   'metric',    'interactions'),
  ('00000000-0000-4000-8000-000000000021', 'Unique [Hover]',   'metric',    'hovered'),
  ('00000000-0000-4000-8000-000000000021', 'Page seen [Main]', 'page_view', 'main'),
  ('00000000-0000-4000-8000-000000000021', 'CTR [global]',     'cta_click', 'clickthrough'),
  ('00000000-0000-4000-8000-000000000021', 'Sound on',         'ignore',    NULL);
