-- Down: remove fail-closed tenant RLS (R1). Owner role.

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."orders";
ALTER TABLE "trade"."orders" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."orders" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."escrows";
ALTER TABLE "trade"."escrows" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."escrows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."shipments";
ALTER TABLE "trade"."shipments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."shipments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."documents";
ALTER TABLE "trade"."documents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."documents" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."payments";
ALTER TABLE "trade"."payments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."payments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."compliance_cases";
ALTER TABLE "trade"."compliance_cases" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."compliance_cases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."disputes";
ALTER TABLE "trade"."disputes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."disputes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."wallets";
ALTER TABLE "trade"."wallets" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."wallets" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."notifications";
ALTER TABLE "trade"."notifications" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."notifications" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."freight_quotes";
ALTER TABLE "trade"."freight_quotes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."freight_quotes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."bills_of_lading";
ALTER TABLE "trade"."bills_of_lading" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."bills_of_lading" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."customs_entries";
ALTER TABLE "trade"."customs_entries" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."customs_entries" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."certificates_of_origin";
ALTER TABLE "trade"."certificates_of_origin" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."certificates_of_origin" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."carbon_footprints";
ALTER TABLE "trade"."carbon_footprints" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."carbon_footprints" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."insurance_policies";
ALTER TABLE "trade"."insurance_policies" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."insurance_policies" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "trade"."insurance_claims";
ALTER TABLE "trade"."insurance_claims" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "trade"."insurance_claims" DISABLE ROW LEVEL SECURITY;
