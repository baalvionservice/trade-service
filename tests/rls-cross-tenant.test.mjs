// R1 (GO/NO-GO) cross-tenant isolation probe — runs against a real Postgres.
//
// Connects as the NON-SUPERUSER baalvion_app role (the only role for which RLS is
// enforced) and asserts the fail-closed tenant_isolation policy from migrations
// 007 + 008 actually isolates tenants. Migration 008 hardens the policy so the
// app.tenant_bypass escape hatch is honoured ONLY for non-app roles; this probe
// therefore seeds each tenant under its own tenant context (no bypass) and
// asserts baalvion_app cannot use tenant_bypass to cross tenants. Regression
// gate for R1.
//
// Run:  DB_HOST=127.0.0.1 node --test tests/rls-cross-tenant.test.mjs
// Env:  DB_HOST(127.0.0.1) DB_PORT(5432) DB_NAME(baalvion_db)
//       BAALVION_APP_USER(baalvion_app) BAALVION_APP_PASSWORD(baalvion_app_dev_2026)
//
// CI spins Postgres, applies 027_app_role.sql + the trade migrations, then runs
// this with the CI app password.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'baalvion_db',
  user: process.env.BAALVION_APP_USER || 'baalvion_app',
  password: process.env.BAALVION_APP_PASSWORD || 'baalvion_app_dev_2026',
};

const A = 'rls-probe-A';
const B = 'rls-probe-B';

async function withClient(fn) {
  const client = new pg.Client(cfg);
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}
const setCtx = (c, tenant, bypass) =>
  c.query("SELECT set_config('app.current_tenant',$1,false), set_config('app.tenant_bypass',$2,false)", [tenant, bypass]);
const countProbe = async (c) =>
  Number((await c.query("SELECT count(*)::int AS n FROM trade.orders WHERE tenant_id LIKE 'rls-probe-%'")).rows[0].n);
// 008 forbids baalvion_app from using app.tenant_bypass, so seed/cleanup each
// tenant under its own tenant context instead of via the bypass escape hatch.
const seedTenant = async (c, tenant) => {
  await setCtx(c, tenant, 'off');
  await c.query("DELETE FROM trade.orders WHERE tenant_id = $1", [tenant]);
  await c.query("INSERT INTO trade.orders (tenant_id,status,created_at,updated_at) VALUES ($1,'pending',now(),now())", [tenant]);
};
const cleanupTenant = async (c, tenant) => {
  await setCtx(c, tenant, 'off');
  await c.query("DELETE FROM trade.orders WHERE tenant_id = $1", [tenant]);
};

test('R1 cross-tenant RLS isolation (as baalvion_app)', async (t) => {
  await withClient(async (c) => {
    // sanity: the runtime role must be a non-superuser without bypassrls.
    const role = (await c.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    assert.equal(role.rolsuper, false, 'runtime role must NOT be superuser');
    assert.equal(role.rolbypassrls, false, 'runtime role must NOT bypass RLS');

    // seed two tenants under their own tenant context (008: app role cannot bypass).
    await seedTenant(c, A);
    await seedTenant(c, B);

    await t.test('fail-closed: no tenant set -> 0 rows', async () => {
      await setCtx(c, '', 'off');
      assert.equal(await countProbe(c), 0);
    });

    await t.test('tenant A sees only A', async () => {
      await setCtx(c, A, 'off');
      const rows = (await c.query("SELECT DISTINCT tenant_id FROM trade.orders WHERE tenant_id LIKE 'rls-probe-%'")).rows;
      assert.deepEqual(rows.map((r) => r.tenant_id), [A]);
    });

    await t.test('tenant B sees only B', async () => {
      await setCtx(c, B, 'off');
      const rows = (await c.query("SELECT DISTINCT tenant_id FROM trade.orders WHERE tenant_id LIKE 'rls-probe-%'")).rows;
      assert.deepEqual(rows.map((r) => r.tenant_id), [B]);
    });

    await t.test('WITH CHECK: tenant A cannot insert a B-tenant row', async () => {
      await setCtx(c, A, 'off');
      await assert.rejects(
        () => c.query("INSERT INTO trade.orders (tenant_id,status,created_at,updated_at) VALUES ($1,'pending',now(),now())", [B]),
        /row-level security/,
      );
    });

    await t.test('hardened (008): app role cannot use tenant_bypass to cross tenants', async () => {
      // app.tenant_bypass is honoured only for NON-app roles. As baalvion_app,
      // flipping it on must NOT reveal other tenants' rows.
      await setCtx(c, '', 'on');
      assert.equal(await countProbe(c), 0, 'baalvion_app + bypass=on must still see 0 rows');
    });

    // cleanup (per-tenant; app role cannot bypass).
    await cleanupTenant(c, A);
    await cleanupTenant(c, B);
  });
});

// R1 read-path cutover (P1-8) — proves middleware/tenantConnection.js's mechanism:
// a per-request DEDICATED connection gets the tenant GUC via session-level
// set_config(..., is_local=false) (NO wrapping transaction, mirroring a controller's
// Model.findAll), serves tenant-scoped non-transactional reads, then is RESET on
// release so the recycled pooled connection is fail-closed for the next request.
test('R1 read-path: non-transactional read is tenant-scoped + reset is leak-proof', async (t) => {
  await withClient(async (c) => {
    // seed two tenants under their own tenant context.
    await seedTenant(c, A);
    await seedTenant(c, B);

    await t.test('stamped connection: non-transactional read sees only own tenant', async () => {
      await setCtx(c, A, 'off');
      const rows = (await c.query(
        "SELECT tenant_id FROM trade.orders WHERE tenant_id LIKE 'rls-probe-%'")).rows;
      assert.equal(rows.length, 1, 'tenant A sees exactly its own row');
      assert.equal(rows[0].tenant_id, A);
    });

    await t.test('release resets GUC: recycled connection is fail-closed', async () => {
      await setCtx(c, '', 'off');
      assert.equal(await countProbe(c), 0, 'after reset, the connection sees no tenant rows');
    });

    await t.test('re-stamp for the next tenant works on the same connection', async () => {
      await setCtx(c, B, 'off');
      const rows = (await c.query(
        "SELECT tenant_id FROM trade.orders WHERE tenant_id LIKE 'rls-probe-%'")).rows;
      assert.deepEqual(rows.map((r) => r.tenant_id), [B], 'tenant B sees only B on the reused connection');
    });

    // cleanup (per-tenant).
    await cleanupTenant(c, A);
    await cleanupTenant(c, B);
  });
});
