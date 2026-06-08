// R1 (GO/NO-GO) cross-tenant isolation probe — runs against a real Postgres.
//
// Connects as the NON-SUPERUSER baalvion_app role (the only role for which RLS is
// enforced) and asserts the fail-closed tenant_isolation policy from migration
// 007 actually isolates tenants. This is the regression gate for R1.
//
// Run:  node --test tests/rls-cross-tenant.test.mjs
// Env:  DB_HOST(127.0.0.1) DB_PORT(5432) DB_NAME(baalvion_db)
//       BAALVION_APP_USER(baalvion_app) BAALVION_APP_PASSWORD(dev_app_pw_2026)
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

test('R1 cross-tenant RLS isolation (as baalvion_app)', async (t) => {
  await withClient(async (c) => {
    // sanity: the runtime role must be a non-superuser without bypassrls.
    const role = (await c.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    assert.equal(role.rolsuper, false, 'runtime role must NOT be superuser');
    assert.equal(role.rolbypassrls, false, 'runtime role must NOT bypass RLS');

    // seed two tenants via bypass.
    await setCtx(c, '', 'on');
    await c.query("DELETE FROM trade.orders WHERE tenant_id LIKE 'rls-probe-%'");
    await c.query(
      "INSERT INTO trade.orders (tenant_id,status,created_at,updated_at) VALUES ($1,'pending',now(),now()),($2,'pending',now(),now())",
      [A, B]);

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

    await t.test('bypass=on sees both tenants', async () => {
      await setCtx(c, '', 'on');
      assert.equal(await countProbe(c), 2);
    });

    // cleanup.
    await setCtx(c, '', 'on');
    await c.query("DELETE FROM trade.orders WHERE tenant_id LIKE 'rls-probe-%'");
  });
});
