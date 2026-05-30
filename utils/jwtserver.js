'use strict';
// Delegates to the canonical backend JWT authority (packages/auth-node) — the ONLY
// sanctioned token path. See catalog/enforce.mjs C3 (no auth duplication).
//
// Phase 6E-8 HARD STATE: HS256 issuance permanently retired. signAccessToken throws
// unconditionally. No env var re-enables it. Rollback = deployment revert.
const { createAuthServer } = require('@baalvion/auth-node');
const config = require('../config/appConfig');

const auth = createAuthServer({ accessSecret: config.jwt.accessSecret, env: config.env });

// RS256 token verification via JWKS — retained for service-internal token checks.
// Not called from authMiddleware.js (gateway-identity-only path in Phase 6E-8).
const verifyAccessToken = (token) => auth.verifyAccessToken(token);

// HS256 issuance permanently retired.
const signAccessToken = () => {
  throw new Error('HS256 PERMANENTLY RETIRED (Phase 6E-8): authenticate via auth-service (RS256) → auth-gateway BFF');
};

module.exports = { verifyAccessToken, signAccessToken };
