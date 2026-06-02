'use strict';
/**
 * RS256 token verifier — Phase 6E-8 HARD STATE.
 *
 * HS256 fallback permanently removed. RS256/JWKS only.
 * JTI blacklist enforced via Redis (fail-closed on Redis outage).
 * No env var can re-enable HS256. Rollback = deployment revert.
 *
 * NOTE: authMiddleware.js no longer calls verify() directly (gateway-identity-only path).
 * This module is retained for any service-internal RS256 token checks (e.g. signed URLs).
 */
const { createJwksVerifier } = require('@baalvion/auth-node');
const config = require('../config/appConfig');

const JWKS_URI = (config.jwt && config.jwt.jwksUri) || process.env.JWKS_URI
  || 'http://localhost:3001/.well-known/jwks.json';

function _loadIORedis() {
  try { return require('ioredis'); } catch {}
  // Removed hardcoded absolute path fallback — only attempt a user-supplied IOREDIS_PATH if present.
  if (process.env.IOREDIS_PATH) {
    try { return require(process.env.IOREDIS_PATH); }
    catch (e) { console.warn('[rsVerifier] IOREDIS_PATH require failed; JTI blacklist check OFF:', e.message); }
  }
  console.warn('[rsVerifier] ioredis not found in node_modules; JTI blacklist check OFF. Install ioredis in this service.');
  return null;
}
let _redis;
function getRedis() {
  if (_redis !== undefined) return _redis;
  const M = _loadIORedis();
  if (!M) { _redis = null; return _redis; }
  const Redis = M.default || M;
  _redis = new Redis({
    host: process.env.REDIS_HOST || (config.redis && config.redis.host) || 'localhost',
    port: Number(process.env.REDIS_PORT || (config.redis && config.redis.port) || 6379),
    password: process.env.REDIS_PASSWORD || (config.redis && config.redis.password) || undefined,
    maxRetriesPerRequest: 2,
  });
  return _redis;
}

/** RS256/JWKS-only verifier with JTI blacklist. HS256 always rejected. */
function makeVerifier({ jwksUri = JWKS_URI, redis = getRedis() } = {}) {
  return createJwksVerifier({
    jwksUri,
    issuer:      'baalvion-auth',
    audience:    'baalvion-platform',
    hs256Secret: undefined,  // HS256 permanently retired (Phase 6E-8)
    rejectHs256: true,       // hard-coded; no env var override
    redis,                   // RS256 JTI blacklist (auth:blacklist:<jti>), fail-closed
  });
}

const _verifier = makeVerifier();

/** Map RS256 claims into the canonical req.auth shape. trade legacy aliases preserved for RS256 tokens. */
function normalize(claims) {
  const roles = Array.isArray(claims.roles) ? claims.roles : (claims.role != null ? [claims.role] : []);
  return {
    userId:      claims.sub != null ? String(claims.sub) : (claims.id != null ? String(claims.id) : ''),
    orgId:       claims.org_id ?? claims.orgId ?? claims.tenantId ?? claims.orgCode ?? null,
    sessionId:   claims.sid ?? claims.sessionId ?? null,
    roles,
    permissions: Array.isArray(claims.permissions) ? claims.permissions : [],
    jti:         claims.jti ?? null,
    issuer:      claims.iss ?? 'baalvion-auth',
    algorithm:   'RS256',
    email:       claims.email ?? null,
    source:      'auth-service',
    claims,
    meta: { issuerSystem: 'auth-service', migrationStatus: 'canonical' },
  };
}

/** Verify an RS256 bearer token → canonical shape. Throws immediately on HS256. */
async function verify(token, verifier = _verifier) {
  const alg = (() => {
    try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString()).alg || null; }
    catch { return null; }
  })();
  if (alg === 'HS256') {
    const e = new Error('HS256 tokens permanently rejected (Phase 6E-8); authenticate via auth-service (RS256)');
    e.code = 'alg_not_allowed'; e.status = 401;
    throw e;
  }
  const claims = await verifier.verify(token);
  return normalize(claims);
}

module.exports = { verify, normalize, makeVerifier };
