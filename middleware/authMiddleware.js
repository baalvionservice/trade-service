'use strict';
// Phase 6E-8 HARD STATE: gateway-only trust boundary.
// Bearer token verification permanently removed. No HS256 path. No fallback auth.
// All authentication flows through auth-gateway (RS256 BFF). No env var override.
// Rollback requires deployment revert (git revert / image rollback).
//
// trade-service shape: req.auth keeps scalar `role` + `tenantId` for backward compat with
// trade-specific controllers and tenantContext.js. orgId is mapped from gateway org_id.
const { bffBridge } = require('./bffBridge');
const { AppError } = require('../utils/errors');

// Maps gateway canonical identity → trade's req.auth / req.user shape.
const gatewayToAuth = (id) => ({
    userId:      id.userId,
    email:       id.email ?? null,
    orgId:       id.orgId ?? null,
    orgCode:     null,
    role:        (id.roles && id.roles[0]) || 'client',  // scalar (highest) — requireRole compat
    roles:       id.roles || [],
    tenantId:    id.orgId ?? null,
    permissions: id.permissions || [],
    source:      'gateway',
    algorithm:   'RS256-gateway',
});

// Hard gate: requires gateway-issued identity. Direct bearer tokens → 401.
const authMiddleware = async (req, res, next) => {
    try {
        const bridged = bffBridge(req);
        if (bridged && bridged.reject) return next(new AppError('UNAUTHORIZED', 'Untrusted gateway identity', 401));
        if (!bridged || !bridged.identity) {
            return next(new AppError('GATEWAY_REQUIRED', 'Authentication via auth-gateway required; direct bearer tokens not accepted', 401));
        }
        req.auth = gatewayToAuth(bridged.identity);
        req.user = { id: req.auth.userId, role: req.auth.role, orgId: req.auth.orgId };
        return next();
    } catch {
        return next(new AppError('UNAUTHORIZED', 'Authentication failed', 401));
    }
};

// Soft gate: gateway identity if present, anonymous otherwise. Bearer tokens ignored.
const optionalAuth = async (req, res, next) => {
    try {
        const bridged = bffBridge(req);
        if (bridged && bridged.reject) return next();   // spoofed header → anonymous
        if (bridged && bridged.identity) {
            req.auth = gatewayToAuth(bridged.identity);
            req.user = { id: req.auth.userId, role: req.auth.role, orgId: req.auth.orgId };
        }
        // No bearer token path.
    } catch { /* anonymous on error */ }
    return next();
};

const requireRole = (...roles) => (req, res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHORIZED', 'Authentication required', 401));
    if (!roles.includes(req.auth.role)) {
        return next(new AppError('FORBIDDEN', `Role '${req.auth.role}' is not authorized for this action`, 403));
    }
    return next();
};

module.exports = { authMiddleware, optionalAuth, requireRole };
