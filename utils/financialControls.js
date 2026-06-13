'use strict';
/**
 * Financial authorization controls shared across money-moving controllers.
 *
 * War Room 3 (Financial Authorization Lockdown). Centralizes the three controls
 * that every money operation must satisfy beyond authentication:
 *
 *   1. Role validation   — only MONEY_ROLES may move money (enforced at the route
 *                          via requireRole; the constant is exported so routes and
 *                          controllers agree on one source of truth).
 *   2. Tenant validation — an ORG admin/owner is tenant-scoped; only a PLATFORM
 *                          operator role may act across tenants. This closes the
 *                          "finance modifies another tenant's transaction" hole
 *                          where org-admin tenant-bypass was previously conflated
 *                          with platform-admin bypass.
 *   3. Approval (dual-control) — above a configurable per-currency threshold a
 *                          single user cannot both request and execute a money
 *                          movement; a DISTINCT approver holding a money role must
 *                          confirm (maker-checker).
 *
 * Mirrors the established precedents in this service:
 *   - insuranceRoutes.js  → requireRole('admin','owner','super_admin') on premium/cancel
 *   - collectionController → BYPASS_ROLES = {platform_admin, platform_security_admin}
 */
const { AppError } = require('./errors');

// Org roles permitted to move money. Viewer/member/editor/client never qualify.
const MONEY_ROLES = ['admin', 'owner', 'super_admin'];

// Platform operator roles that may act ACROSS tenants. An org admin/owner is NOT
// one of these — they remain tenant-scoped on money operations.
const PLATFORM_BYPASS_ROLES = new Set(['platform_admin', 'platform_security_admin']);

function callerRoles(req) {
    return (req && req.auth && req.auth.roles) || [];
}

function actorId(req) {
    return (req && req.auth && (req.auth.userId || req.auth.sub)) || 'system';
}

function callerTenantId(req) {
    return (req && req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}

/** True only for genuine platform operators (never for org admin/owner). */
function hasPlatformBypass(req) {
    return callerRoles(req).some((r) => PLATFORM_BYPASS_ROLES.has(r));
}

/**
 * Enforce tenant ownership on a money record. Returns true if allowed; otherwise
 * throws 404 (do NOT leak the existence of another tenant's record with a 403).
 * Only platform operators bypass tenant ownership.
 */
function assertTenantOwnership(record, req) {
    if (hasPlatformBypass(req)) return true;
    const tenantId = callerTenantId(req);
    const recTenant = record && (record.tenant_id || record.tenantId);
    if (tenantId && recTenant && String(recTenant) !== String(tenantId)) {
        throw new AppError('NOT_FOUND', 'Resource not found', 404);
    }
    return true;
}

// ── Dual-control (maker-checker) ────────────────────────────────────────────
// Threshold is configured in MAJOR currency units via env:
//   APPROVAL_THRESHOLD_<CCY>   (e.g. APPROVAL_THRESHOLD_USD=250000)
//   APPROVAL_THRESHOLD_DEFAULT (fallback for any currency)
// Default 1,000,000 major units when unset.
const DEFAULT_THRESHOLD = 1_000_000;

function thresholdFor(currency) {
    const ccy = String(currency || 'DEFAULT').toUpperCase();
    const raw = process.env[`APPROVAL_THRESHOLD_${ccy}`] || process.env.APPROVAL_THRESHOLD_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD;
}

function requiresDualApproval(amount, currency) {
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return false;
    return amt >= thresholdFor(currency);
}

/**
 * Evaluate the maker-checker state for a high-value operation against a JSONB
 * `state` bag (e.g. an Escrow's release_conditions). Pure function — the caller
 * persists the returned `nextState` and acts on `decision`.
 *
 * decision:
 *   'execute'         → below threshold OR a distinct approver has confirmed; proceed.
 *   'await_approval'  → first leg recorded (maker); do NOT move money yet.
 *   throws FORBIDDEN  → same user attempted to approve their own request.
 *
 * @returns {{ decision:'execute'|'await_approval', nextState:object }}
 */
function evaluateDualControl({ state = {}, amount, currency, action, req }) {
    const me = String(actorId(req));
    if (!requiresDualApproval(amount, currency)) {
        return { decision: 'execute', nextState: state };
    }
    const dc = state.dual_control;
    if (!dc || !dc.requested_by || dc.action !== action) {
        // First leg: record the maker; money does NOT move.
        return {
            decision: 'await_approval',
            nextState: {
                ...state,
                dual_control: { action, requested_by: me, requested_at: new Date().toISOString() },
            },
        };
    }
    if (String(dc.requested_by) === me) {
        throw new AppError(
            'FORBIDDEN',
            'Dual control: this operation was requested by you and requires approval by a different authorized user',
            403,
        );
    }
    // Distinct approver with a money role (enforced at the route) confirms.
    return {
        decision: 'execute',
        nextState: { ...state, dual_control: { ...dc, approved_by: me, approved_at: new Date().toISOString() } },
    };
}

module.exports = {
    MONEY_ROLES,
    PLATFORM_BYPASS_ROLES,
    callerRoles,
    actorId,
    callerTenantId,
    hasPlatformBypass,
    assertTenantOwnership,
    thresholdFor,
    requiresDualApproval,
    evaluateDualControl,
};
