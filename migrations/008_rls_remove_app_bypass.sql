-- CR-8: the tenant RLS bypass (app.tenant_bypass = 'on') was reachable by the
-- runtime application role itself, so any SQL injection that ran SET
-- app.tenant_bypass = 'on' before the tenant GUC defeated isolation on every
-- financial table. This migration recreates every policy so the bypass is
-- ONLY honoured for roles that are NOT the application role 'baalvion_app'
-- (i.e. dedicated admin/superuser tooling), never for the runtime connection.

DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders','escrows','shipments','documents','payments','compliance_cases',
    'disputes','wallets','notifications','freight_quotes','bills_of_lading',
    'customs_entries','certificates_of_origin','carbon_footprints',
    'insurance_policies','insurance_claims'
  ]
  LOOP
    EXECUTE format('ALTER TABLE "trade".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE "trade".%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation" ON "trade".%I', t);
    EXECUTE format($pol$
      CREATE POLICY "tenant_isolation" ON "trade".%I
        USING (
          (current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app')
          OR (
            current_setting('app.current_tenant', true) IS NOT NULL
            AND current_setting('app.current_tenant', true) <> ''
            AND "tenant_id"::text = current_setting('app.current_tenant', true)
          )
        )
        WITH CHECK (
          (current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app')
          OR (
            current_setting('app.current_tenant', true) IS NOT NULL
            AND current_setting('app.current_tenant', true) <> ''
            AND "tenant_id"::text = current_setting('app.current_tenant', true)
          )
        )
    $pol$, t);
  END LOOP;
END
$rls$;
