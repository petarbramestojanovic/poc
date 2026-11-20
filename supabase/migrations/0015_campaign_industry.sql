-- 0015_campaign_industry.sql — the industry a campaign belongs to.
--
-- CHANGE TO RFC-004 TABLES, approved by the product owner on 2026-11-20. RFC-004 has no industry:
-- this adds a table of its own and two columns to app.campaign, and grants a logged-in reader
-- those two columns. docs/RFC-004 is kept verbatim, so this header is the record of the deviation.
-- Additive: nothing existing changes.
--
-- Every campaign gets one industry ('FMCG / CPG', 'Retail' …), for benchmarks across clients. No
-- CRM states it, so we decide it, right after Salesforce pushes the opportunity (CLAUDE.md,
-- Industries): a keyword table in code (src/modules/industries/map.ts) names known brands in the
-- transaction that creates the campaign; for the others an LLM picks one of the names below in the
-- background. Once set it never changes on its own, and a value a person set is never overwritten.
--
--   app.industry               the list an industry is chosen from: its name and a definition the
--                              LLM is given to choose by. Seeded here, since production needs the
--                              same list. Renaming one carries over to the campaigns that have it.
--   app.campaign.industry      one of those names; NULL until something decided it.
--   app.campaign.industry_source  who decided it: 'map' (the keyword table), 'llm', or 'manual'
--                              (a person, PUT /campaigns/:id/industry). Both or neither.

CREATE TABLE app.industry (
  name        text PRIMARY KEY CHECK (name <> ''),
  definition  text NOT NULL CHECK (definition <> ''),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.industry ENABLE ROW LEVEL SECURITY;
-- No grant and no policy on app.industry: readers see the name on app.campaign.

COMMENT ON TABLE app.industry IS
  'The industries a campaign can belong to, with the definition the classifier chooses by.';

INSERT INTO app.industry (name, definition) VALUES
  ('Automotive',           'Car Manufacturers, Car Service, Garages, Car Suppliers'),
  ('eCommerce',            'eCommerce Platforms without physical stores, i.e. Otto Group, Amazon, Zalando, etc.'),
  ('Entertainment',        'Movie theatres, Streaming provider, TV stations, radio stations, etc.'),
  ('Finance & Insurance',  'Banks, Insurance Companies, Trust Funds, etc.'),
  ('FMCG / CPG',           'All kinds of Fast Moving Consumer Goods, Food, Beauty, Over-the-Counter Medicine, Non-alcoholic beverages, alcoholic beverages, etc.'),
  ('Food Retail',          'Retailers that sell only food and groceries — grocery stores and food discounters, e.g. Penny, Lidl, Hofer. (Distinct from Retail, which covers companies with their own brick-and-mortar channels more broadly, and from FMCG / CPG, the consumer goods themselves.)'),
  ('Other Industries',     'Any campaign that does not clearly fit one of the other categories.'),
  ('Retail',               'Companies with their own brick-and-mortar retail channels that are NOT grocery-only — e.g. home appliances and electronics, coffee/specialty and department stores. (Retailers that sell only food & groceries belong in Food Retail; the consumer goods themselves belong in FMCG / CPG.)'),
  ('Tech-Telco',           'OEMs, cell phone manufacturers, Telecommunication Providers, Computers, Software, etc.'),
  ('Technical Appliances', 'White goods from manufacturers like BSH Bosch, LG, Samsung, Electrolux, etc.'),
  ('Travel & Tourism',     'Hotels, Travel Agencies, Tourism Regions, Airlines, Car Rental, etc.');

ALTER TABLE app.campaign
  ADD COLUMN industry         text REFERENCES app.industry(name) ON UPDATE CASCADE,
  ADD COLUMN industry_source  text,
  ADD CONSTRAINT campaign_industry_pair
    CHECK ((industry IS NULL) = (industry_source IS NULL)),
  ADD CONSTRAINT campaign_industry_source_known
    CHECK (industry_source IN ('map', 'llm', 'manual'));

-- Every foreign-key column is indexed (CLAUDE.md); benchmarks group by it too.
CREATE INDEX campaign_industry_idx ON app.campaign (industry);

COMMENT ON COLUMN app.campaign.industry IS
  'The campaign''s industry (app.industry); NULL until classified. Never changes on its own.';
COMMENT ON COLUMN app.campaign.industry_source IS
  'Who set the industry: map (keyword table), llm, or manual (a person). NULL with industry.';

-- A logged-in reader may see the industry and who set it: the console groups benchmarks by it.
-- Since 0010 a column of app.campaign stays closed until a migration grants it; these two are.
GRANT SELECT (industry, industry_source) ON app.campaign TO authenticated;
