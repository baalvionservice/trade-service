'use strict';
/**
 * Phase 6E-5 — unified island session normalizer.
 *
 * Maps BOTH auth sources into ONE canonical req.auth contract so the app layer never
 * has to know how the caller authenticated:
 *   - RS256 gateway identity  → signed x-* headers verified by bffBridge (source: 'gateway')
 *   - bearer-token claims      → RS256 (auth-service) or legacy HS256 island, already
 *                                normalized by dualTokenVerifier (source: 'auth-service' |
 *                                'island-hs256')
 *
 * NO breaking change to the Supabase-compat adapter or to existing bearer-path behavior —
 * this only adds a second, equivalent way to populate req.auth.
 */

// Gateway (BFF) signed-header identity → canonical shape.
function normalizeGateway({ userId, orgId, roles, sessionId } = {}) {
  return {
    userId:      userId != null ? String(userId) : '',
    orgId:       orgId || null,
    roles:       Array.isArray(roles) ? roles : [],
    permissions: [],                 // not carried in headers (hybrid: the injected JWT still has them)
    sessionId:   sessionId || null,
    email:       null,
    source:      'gateway',          // 6E-5 contract
    algorithm:   'RS256-gateway',
  };
}

// dualTokenVerifier output (bearer path) → same canonical shape. HS256 → 'island-hs256'.
function normalizeClaims(v = {}) {
  return {
    userId:      v.userId,
    orgId:       v.orgId ?? null,
    roles:       Array.isArray(v.roles) ? v.roles : [],
    permissions: Array.isArray(v.permissions) ? v.permissions : [],
    sessionId:   v.sessionId ?? null,
    email:       v.email ?? null,
    source:      v.source === 'auth-service' ? 'auth-service' : 'island-hs256',
    algorithm:   v.algorithm || null,
  };
}

module.exports = { normalizeGateway, normalizeClaims };
