-- Down for 006a — drop the logistics/insurance tables this migration introduced.
-- Order is irrelevant: these tables hold only loose VARCHAR/TEXT id references
-- (no inter-table FKs), so there is no dependency chain to respect.
DROP TABLE IF EXISTS "trade"."insurance_claims";
DROP TABLE IF EXISTS "trade"."insurance_policies";
DROP TABLE IF EXISTS "trade"."carbon_footprints";
DROP TABLE IF EXISTS "trade"."certificates_of_origin";
DROP TABLE IF EXISTS "trade"."customs_entries";
DROP TABLE IF EXISTS "trade"."bills_of_lading";
DROP TABLE IF EXISTS "trade"."freight_quotes";
DROP TABLE IF EXISTS "trade"."carriers";
