# R1 — Cross-Tenant RLS Cutover (ticket P1-8)

Flip `trade-service` to run as the non-superuser `baalvion_app` role so Postgres
Row-Level Security (migration `007_rls_tenant_isolation.sql`) is actually enforced
at the database layer.

## What makes this safe

RLS is driven by two session GUCs (`app.current_tenant` / `app.tenant_bypass`,
fail-closed). With `FORCE ROW LEVEL SECURITY` + a non-superuser role, every query on
a connection where the GUC is unset returns **zero rows**.

Two layers stamp the GUC, covering all DB access:

1. **Managed write transactions** — `index.js` wraps `sequelize.transaction` to set
   the GUC `LOCAL` to every managed transaction from the request's tenant ALS context.
2. **Non-transactional reads** — `middleware/tenantConnection.js` opens **one
   request-scoped transaction**, sets the GUC `LOCAL` to it, and routes every
   otherwise-non-transactional `sequelize.query` (i.e. all the controller
   `findAll/findByPk/findAndCountAll/count` calls) onto it. Committed on response
   finish, rolled back if the socket closes early. `SET LOCAL` is leak-proof — the GUC
   vanishes on commit, so a recycled pooled connection never carries a stale tenant.

Both layers are **no-ops under the current owner connection** (RLS is bypassed for the
DB owner), so behaviour is unchanged until `DB_USER` is flipped. Admin/owner/super_admin
get `bypass='on'` (see all tenants); anonymous/refresh/login get no tenant (auth and
refresh-token tables are excluded from RLS, so they keep working).

## Cutover steps

1. Confirm the role + RLS exist on `baalvion-postgres` (already applied):
   - role `baalvion_app` (NOSUPERUSER, NOBYPASSRLS), password `baalvion_app_dev_2026`
   - migration `007_rls_tenant_isolation.sql` applied (16 `trade.*` tables, FORCE RLS)

2. Run the regression gate (must pass) BEFORE flipping:

   ```
   DB_HOST=127.0.0.1 node --test tests/rls-cross-tenant.test.mjs
   ```

3. Flip the runtime DB credentials in the service `.env`:

   ```
   DB_USER=baalvion_app
   DB_PASSWORD=baalvion_app_dev_2026
   ```

   (Keep `DB_HOST=127.0.0.1`, `DB_PORT=5432`, `DB_NAME=baalvion_db`. In production use a
   secret manager, not a literal password.)

4. Restart the service:

   ```
   pm2 restart trade-service
   ```

5. Smoke-test reads + writes with a real tenant token:
   - `GET /v1/orders` (or any list endpoint) → returns ONLY the caller's tenant rows
     (was returning data before the flip; if it now returns `[]` for a tenant that has
     data, the GUC is not being stamped — check `tenantContext` resolved a `tenantId`).
   - Create an order → succeeds and is stamped with the caller's tenant.
   - An admin/owner/super_admin token → sees all tenants (bypass).
   - A second tenant's token → cannot see the first tenant's rows.

## Rollback

Revert `DB_USER`/`DB_PASSWORD` to the owner role in `.env` and `pm2 restart
trade-service`. The GUC-stamping layers stay in place (harmless no-op under the owner),
so no code revert is needed.
