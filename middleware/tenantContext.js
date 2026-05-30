'use strict';
/**
 * Request-scoped tenant context via AsyncLocalStorage. Decodes the bearer token (if
 * any) and runs the rest of the request inside an ALS scope, so the Sequelize tenant
 * hooks (models/index.js) auto-inject the tenant filter on every query.
 *
 * Phase 3C — tenancy normalization: verification now goes through the dual verifier,
 * so BOTH token types resolve a tenant:
 *   - HS256 (legacy island): tenantId from the legacy `tenantId` claim.
 *   - RS256 (auth-service):  canonical `org_id` is mapped to `tenantId` (compat layer).
 * Async because RS256 verification fetches JWKS. HS256 issuance + utils/jwtserver.js UNCHANGED.
 *
 *  - role admin/owner/super_admin -> bypass (sees all tenants)
 *  - no/invalid token             -> no tenant (no auto-scoping; protected routes still 401 in authMiddleware)
 */
const { AsyncLocalStorage } = require('async_hooks');
const { verify } = require('./dualTokenVerifier');
const { bffBridge } = require('./bffBridge');

const als = new AsyncLocalStorage();

// Canonical org_id -> legacy tenantId (Phase 3C). Prefer the legacy claim, else org_id.
function resolveTenant(a) {
    if (!a) return null;
    return (a.claims && a.claims.tenantId) || a.orgId || a.org_id || null;
}

async function tenantContext(req, res, next) {
    const ctx = { tenantId: null, role: null, userId: null, orgCode: null, bypass: false, source: null };
    const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
    if (token) {
        try {
            const a = await verify(token);
            ctx.tenantId = resolveTenant(a);
            ctx.role = (a.roles && a.roles[0]) || null;
            ctx.userId = a.userId;
            ctx.orgCode = (a.claims && a.claims.orgCode) || null;
            ctx.bypass = (a.roles || []).some((r) => r === 'admin' || r === 'owner' || r === 'super_admin');
            ctx.source = a.source;
        } catch { /* invalid token → anonymous (no scoping); protected routes still 401 in authMiddleware */ }
    } else {
        // Phase 6E-5: no bearer (e.g. gateway strict mode) → derive tenant from a verified gateway
        // identity. org_id is mapped to tenantId (compat). A spoofed signature yields no identity →
        // no scoping. orgCode stays null for gateway users (participant scoping is a follow-up).
        const bridged = bffBridge(req);
        if (bridged && bridged.identity) {
            const a = bridged.identity;
            ctx.tenantId = a.orgId || null;
            ctx.role = (a.roles && a.roles[0]) || null;
            ctx.userId = a.userId;
            ctx.bypass = (a.roles || []).some((r) => r === 'admin' || r === 'owner' || r === 'super_admin');
            ctx.source = 'gateway';
        }
    }
    req.tenant = ctx;
    req.tenantId = ctx.tenantId;                                          // Phase 3C normalized field
    req.tenantContext = { tenantId: ctx.tenantId, source: ctx.source };   // Phase 3C
    als.run(ctx, () => next());
}

const currentTenant = () => als.getStore();

// Run a function with an explicit tenant/bypass context (system jobs, seeds).
const runAs = (ctx, fn) => als.run({ tenantId: null, role: null, userId: null, bypass: false, ...ctx }, fn);

module.exports = { tenantContext, currentTenant, runAs, als };
