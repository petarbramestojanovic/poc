-- 0005_campaign_price.sql — what a campaign is sold for.
--
-- ADDITIVE CHANGE TO RFC-004 TABLES, approved by the product owner on 2026-09-22. RFC-004 §4
-- defines app.campaign without a price; docs/RFC-004 is kept verbatim, so this header is the
-- record of the deviation.
--
--   price      what the client pays for 1000 impressions (CPM, the only pricing model sold). In a
--              Salesforce opportunity that is 'N/N Price', not 'Amount' (price × impressions / 1000)
--   currency   ISO 4217 code of that price: 'EUR', 'CHF', …
--
-- Both NULL while the price is not known, and never 0 for "not known": 0 is a campaign given
-- away. Set together or not at all, since a price without its currency means nothing. Four
-- decimals because prices are sold that way (15.5876); the API refuses a fifth rather than let
-- the column round it. A second pricing model would be a new column (pricing_model DEFAULT
-- 'cpm'), so every price stored before it keeps its meaning.

ALTER TABLE app.campaign
  ADD COLUMN price    numeric(12, 4),
  ADD COLUMN currency text,
  ADD CONSTRAINT campaign_price_pair
    CHECK ((price IS NULL) = (currency IS NULL)),
  ADD CONSTRAINT campaign_price_not_negative
    CHECK (price >= 0),
  ADD CONSTRAINT campaign_currency_format
    CHECK (currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN app.campaign.price    IS 'Price of 1000 impressions (CPM) in currency; NULL when not known.';
COMMENT ON COLUMN app.campaign.currency IS 'ISO 4217 code of price; NULL exactly when price is.';
