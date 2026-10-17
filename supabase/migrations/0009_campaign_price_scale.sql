-- 0009_campaign_price_scale.sql — a campaign's price with up to six decimals.
--
-- CHANGE TO AN APPROVED RFC-004 DEVIATION, approved by the product owner on 2026-10-17. Not
-- additive: it widens app.campaign.price (migration 0005) from numeric(12,4) to numeric(14,6).
--
-- Salesforce's N_N_Price__c carries more than four decimals (0.39525 and 5.31686 in the export
-- of 2026-10-15). With four, the API had to refuse those prices, and the campaigns had none. Six
-- keep every price sold so far exactly; the integer part stays at eight digits. The API still
-- refuses a seventh decimal rather than let the column round it.
--
-- Every stored price keeps its value; only its text gains zeros ('15.5876' reads back as
-- '15.587600'). The table is rewritten under an ACCESS EXCLUSIVE lock, which at the size of
-- app.campaign takes moments.

ALTER TABLE app.campaign ALTER COLUMN price TYPE numeric(14, 6);
