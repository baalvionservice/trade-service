'use strict';
/**
 * R1 read-path cutover (ticket P1-8) — request-scoped tenant transaction.
 *
 * THE PROBLEM
 * -----------
 * DB-level Row-Level Security (migration 007) is driven by two session GUCs
 * (app.current_tenant / app.tenant_bypass) and fails closed: with FORCE RLS and a
 * non-superuser runtime role (baalvion_app), any query on a connection where the
 * GUC is unset returns ZERO rows. index.js already stamps the GUC LOCAL to every
 * MANAGED transaction, but controllers run ~100 NON-transactional reads
 * (Model.findAll/findByPk/findAndCountAll/count). Each grabs an arbitrary pooled
 * connection with no GUC set → fail-closed → empty results once we flip to
 * baalvion_app. Converting every read to a transaction by hand is invasive.
 *
 * THE MECHANISM (chosen: one request-scoped transaction, GUC set LOCAL)
 * --------------------------------------------------------------------
 * On each request we open ONE unmanaged transaction, set the tenant GUCs LOCAL to it
 * (SET LOCAL semantics via set_config(..., is_local=true) — they vanish on commit, so
 * they CANNOT leak onto the next request that reuses the pooled connection), and pin
 * the transaction in an AsyncLocalStorage slot. A single monkeypatch of
 * sequelize.query routes any query that has no explicit `transaction` onto the pinned
 * transaction, so unmodified controller reads automatically run with the right GUC on
 * the transaction's pinned connection. On response finish/close we COMMIT (releasing
 * the connection); on error we roll back.
 *
 * Why a transaction and not a bare dedicated connection: in this Sequelize/postgres
 * version, sequelize.query({ connection }) does NOT reliably run on the supplied
 * connection (it can pick a different pooled backend), so a session-level GUC set on a
 * hand-acquired connection is not seen by the routed query. A transaction IS honored
 * — query({ transaction }) always runs on the transaction's pinned backend — and
 * SET LOCAL is inherently leak-proof. This reuses the exact mechanism index.js already
 * uses for managed transactions, which the R1 probe verifies.
 *
 * SAFETY / NO-OP UNDER THE CURRENT OWNER CONNECTION
 * -------------------------------------------------
 * Setting the GUC inside a transaction is harmless under the current superuser owner
 * role — RLS is bypassed for the owner, so reads behave exactly as before. Behaviour
 * only changes once DB_USER=baalvion_app (the cutover). Managed write transactions
 * still go through index.js's LOCAL GUC bridge unchanged; this module only governs
 * otherwise-non-transactional queries.
 *
 * AUTH / ANONYMOUS PATHS
 * ----------------------
 * tenantContext sets ctx.bypass for admin/owner/super_admin and leaves tenantId null
 * for anonymous/refresh/login. We mirror that into the GUC: bypass='on' for admins;
 * tenant=''/bypass='off' for anonymous (fail-closed — anonymous reads of tenant-scoped
 * tables legitimately see nothing; auth/refresh tables are RLS-excluded so they work
 * without a tenant).
 */
const { AsyncLocalStorage } = require('async_hooks');
const { currentTenant } = require('./tenantContext');

// Per-request pinned-transaction slot.
const txAls = new AsyncLocalStorage();
// Reentrancy guard so the SET-LOCAL / BEGIN / COMMIT queries we issue ourselves are
// NOT recursively routed back into the pinned transaction (would deadlock/recurse).
const bypassRouting = new AsyncLocalStorage();

let _patched = false;

/**
 * Install the sequelize.query router exactly once. Any query lacking an explicit
 * transaction is routed onto the request's pinned transaction (if one exists and we
 * are not inside our own bookkeeping query). Queries with their own transaction — and
 * all queries made outside a request scope (workers, migrations, seeds) — pass
 * through untouched.
 */
function installQueryRouter(sequelize) {
    if (_patched) return;
    _patched = true;
    const origQuery = sequelize.query.bind(sequelize);
    // Expose the un-routed query for our own bookkeeping (BEGIN/SET LOCAL/COMMIT run
    // through the transaction object, but SET LOCAL goes via origQuery with {transaction}).
    sequelize.__origQuery = origQuery;
    sequelize.query = function tenantRoutedQuery(sql, options) {
        if (bypassRouting.getStore()) return origQuery(sql, options);
        const slot = txAls.getStore();
        const tx = slot && slot.transaction;
        if (tx && (!options || !options.transaction)) {
            return origQuery(sql, { ...(options || {}), transaction: tx });
        }
        return origQuery(sql, options);
    };
}

/** Stamp the tenant GUCs LOCAL to the given transaction (vanish on commit). */
async function setTenantGuc(sequelize, tx, tenant, bypass) {
    await bypassRouting.run(true, () =>
        sequelize.__origQuery(
            "SELECT set_config('app.current_tenant', $tenant, true), set_config('app.tenant_bypass', $bypass, true)",
            { bind: { tenant, bypass }, transaction: tx },
        ));
}

/**
 * Express middleware: open one tenant transaction for the request, stamp the tenant
 * GUC LOCAL to it, pin it for the request's async scope, and commit (or roll back) on
 * response completion.
 */
function tenantConnection(sequelize) {
    installQueryRouter(sequelize);
    return function tenantConnectionMiddleware(req, res, next) {
        const ctx = currentTenant() || {};
        const tenant = ctx.tenantId == null ? '' : String(ctx.tenantId);
        const bypass = ctx.bypass ? 'on' : 'off';

        // Open the request transaction OUTSIDE the router (bypassRouting) so the
        // implicit BEGIN is not re-routed. sequelize.transaction() with no callback is
        // unmanaged — we own commit/rollback.
        bypassRouting.run(true, () => sequelize.transaction())
            .then(async (tx) => {
                await setTenantGuc(sequelize, tx, tenant, bypass);
                const slot = { transaction: tx, settled: false };
                const settle = (rollback) => {
                    if (slot.settled) return Promise.resolve();
                    slot.settled = true;
                    const op = rollback ? tx.rollback() : tx.commit();
                    return op.catch(() => {}); // pool reclaims the connection regardless
                };
                // Commit on a clean finish; roll back if the socket closed early.
                res.on('finish', () => { settle(false); });
                res.on('close', () => { settle(res.writableFinished ? false : true); });
                txAls.run(slot, () => next());
            })
            .catch((err) => next(err));
    };
}

module.exports = { tenantConnection, txAls };
