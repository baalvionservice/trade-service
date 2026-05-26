'use strict';
/**
 * Request-scoped tenant context via AsyncLocalStorage. The middleware decodes
 * the bearer token (if any) and runs the rest of the request inside an ALS
 * scope, so the Sequelize tenant hooks (models/index.js) can auto-inject the
 * tenant filter on every query without each controller having to thread it.
 *
 *  - role 'admin'  -> bypass (platform super-admin sees all tenants)
 *  - no token      -> no tenant (no auto-scoping; e.g. login, public reads)
 */
const { AsyncLocalStorage } = require('async_hooks');
const jwtserver = require('../utils/jwtserver');

const als = new AsyncLocalStorage();

function tenantContext(req, res, next) {
    const ctx = { tenantId: null, role: null, userId: null, orgCode: null, bypass: false };
    const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
    if (token) {
        try {
            const decoded = jwtserver.verifyAccessToken(token);
            ctx.tenantId = decoded.tenantId || null;
            ctx.role = decoded.role || null;
            ctx.userId = decoded.id;
            ctx.orgCode = decoded.orgCode || null;
            ctx.bypass = decoded.role === 'admin';
        } catch { /* invalid token → anonymous (no scoping); protected routes still 401 in authMiddleware */ }
    }
    req.tenant = ctx;
    als.run(ctx, () => next());
}

const currentTenant = () => als.getStore();

// Run a function with an explicit tenant/bypass context (system jobs, seeds).
const runAs = (ctx, fn) => als.run({ tenantId: null, role: null, userId: null, bypass: false, ...ctx }, fn);

module.exports = { tenantContext, currentTenant, runAs, als };
