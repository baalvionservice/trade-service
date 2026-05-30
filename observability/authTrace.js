'use strict';
/**
 * Phase 6E-6 — auth-flow observability. PURE OBSERVABILITY: it logs on response 'finish' and
 * NEVER alters the request/response or rejects anything. Fail-open: any tracing error is swallowed.
 *
 * Phase 6E-6.5 update: DUAL TELEMETRY STREAMS.
 *   production_stream  — live HTTP requests via runtime middleware.  ENFORCEMENT SOURCE.
 *   simulation_stream  — analytics scripts (consistency, strict-sim, shadow-mirror, risk model).
 *                        MUST NEVER feed SYSTEM_RISK_SCORE / hs256Share / mismatchRate / tenantDrift.
 *
 * Every event gains two new fields vs 6E-6:
 *   identity_mode: "gateway" | "rs256" | "hs256" | "anonymous"
 *   stream:        "production" | "simulation"
 *
 * Full event shape:
 *   { timestamp, service, auth_source, identity_mode, stream, mode,
 *     result, userId, orgId, roles[], path, strict_would_reject }
 *
 * Redis keys (segregated; legacy keys kept read-only for backfill):
 *   auth:trace:prod:recent          auth:trace:prod:counters:<svc>   ← risk scoring reads HERE
 *   auth:trace:sim:recent           auth:trace:sim:counters:<svc>
 *   auth:trace:recent               auth:trace:counters:<svc>        ← legacy (backfill only)
 */
const MAX_RING = 500;
const PROD_RECENT_KEY = 'auth:trace:prod:recent';
const SIM_RECENT_KEY  = 'auth:trace:sim:recent';
const RECENT_MAX = 2000;
const PROD_COUNTERS_KEY = (svc) => `auth:trace:prod:counters:${svc}`;
const SIM_COUNTERS_KEY  = (svc) => `auth:trace:sim:counters:${svc}`;
// Legacy keys — nothing new writes here; kept so backfill can read them.
const RECENT_KEY    = 'auth:trace:recent';
const COUNTERS_KEY  = (svc) => `auth:trace:counters:${svc}`;

const ring = { production: [], simulation: [] };

// ---- redis (lazy, fail-open; same instance the islands/gateway already use) ----
let _redis;
function getRedis() {
  if (_redis !== undefined) return _redis;
  let M;
  try { M = require('ioredis'); }
  catch {
    try { M = require(process.env.IOREDIS_PATH || 'd:/Baalvion Projects/Backend/services/identity/auth-service/node_modules/ioredis'); }
    catch { _redis = null; return _redis; }
  }
  try {
    const Redis = M.default || M;
    _redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });
    _redis.on('error', () => { /* transient redis errors must never surface to a request */ });
  } catch { _redis = null; }
  return _redis;
}

// Normalize the many internal source tags into the 6E-6 reporting vocabulary.
function normSource(s) {
  if (s === 'gateway') return 'gateway';
  if (s === 'auth-service') return 'auth-service';
  if (s === 'legacy-island' || s === 'island-hs256' || s === 'HS256-legacy') return 'island-hs256';
  return s || 'anonymous';
}

// Map auth_source to the higher-level identity_mode bucket.
function toIdentityMode(auth_source) {
  if (auth_source === 'gateway') return 'gateway';
  if (auth_source === 'auth-service') return 'rs256';
  if (auth_source === 'island-hs256') return 'hs256';
  return 'anonymous';
}

// Build the event from whatever identity the auth layer resolved (req.auth or gateway req.user).
function buildEvent(service, req, opts = {}) {
  const id = req.auth || req.user || {};
  const roles = Array.isArray(id.roles) ? id.roles : (id.role ? [id.role] : []);
  const status = opts.statusCode;
  const authed = id.userId != null;
  const authRejected = status === 401 || status === 403;
  const result = opts.result || (authRejected ? 'reject' : (authed ? 'accept' : 'anonymous'));
  const auth_source = normSource(opts.authSource || id.source);
  const stream = opts.stream || 'production';
  return {
    timestamp: new Date().toISOString(),
    service,
    auth_source,
    identity_mode: toIdentityMode(auth_source),
    stream,
    mode: (process.env.ISLAND_AUTH_MODE || (service === 'auth-gateway' ? 'gateway' : 'hybrid')).toLowerCase(),
    result,
    userId: id.userId != null ? String(id.userId) : null,
    orgId: id.orgId ?? id.tenantId ?? null,
    roles,
    path: String(opts.path || req.originalUrl || req.url || '').split('?')[0],
    // STEP 3 strict-mode SIMULATION — applies to ISLAND services only.
    strict_would_reject: service !== 'auth-gateway' && result === 'accept' && auth_source !== 'gateway',
  };
}

function record(evt) {
  try {
    process.stdout.write('AUTHTRACE ' + JSON.stringify(evt) + '\n');
    const bucket = evt.stream === 'simulation' ? 'simulation' : 'production';
    ring[bucket].push(evt); if (ring[bucket].length > MAX_RING) ring[bucket].shift();
    const r = getRedis();
    if (r) {
      const isProd = bucket === 'production';
      const recentKey = isProd ? PROD_RECENT_KEY : SIM_RECENT_KEY;
      const cKey = (isProd ? PROD_COUNTERS_KEY : SIM_COUNTERS_KEY)(evt.service);
      const p = r.pipeline();
      p.hincrby(cKey, 'total', 1);
      p.hincrby(cKey, evt.result === 'reject' ? 'reject' : (evt.result === 'accept' ? 'accept' : 'anonymous'), 1);
      p.hincrby(cKey, 'src_' + evt.auth_source.replace(/[^a-z0-9]/gi, '_'), 1);
      p.hincrby(cKey, 'imode_' + (evt.identity_mode || 'unknown'), 1);
      if (evt.strict_would_reject) p.hincrby(cKey, 'strict_would_reject', 1);
      p.lpush(recentKey, JSON.stringify(evt));
      p.ltrim(recentKey, 0, RECENT_MAX - 1);
      p.exec(() => { /* ignore — fail-open */ });
    }
  } catch { /* observability must NEVER break a request */ }
  return evt;
}

// Express middleware: always writes to production stream.
function middleware(service) {
  return function authTrace(req, res, next) {
    res.on('finish', () => { try { record(buildEvent(service, req, { statusCode: res.statusCode, stream: 'production' })); } catch { /* */ } });
    next();
  };
}

// Simulation recording for scripts — writes to simulation stream, never production.
function recordSimulation(service, partialEvt) {
  const auth_source = normSource(partialEvt.auth_source || '');
  return record({
    timestamp: new Date().toISOString(),
    service,
    auth_source,
    identity_mode: toIdentityMode(auth_source),
    stream: 'simulation',
    mode: partialEvt.mode || 'simulation',
    result: partialEvt.result || 'anonymous',
    userId: partialEvt.userId ?? null,
    orgId: partialEvt.orgId ?? null,
    roles: partialEvt.roles || [],
    path: partialEvt.path || '/',
    strict_would_reject: partialEvt.strict_would_reject || false,
  });
}

const getRecent = (n = 100, stream = 'production') => (ring[stream] || ring.production).slice(-n);

async function getCounters(service, stream = 'production') {
  const r = getRedis(); if (!r) return null;
  const key = (stream === 'simulation' ? SIM_COUNTERS_KEY : PROD_COUNTERS_KEY)(service);
  const h = await r.hgetall(key); const o = {}; for (const k in h) o[k] = Number(h[k]); return o;
}

async function getAllCounters(stream = 'production') {
  const r = getRedis(); if (!r) return {};
  const pattern = stream === 'simulation' ? 'auth:trace:sim:counters:*' : 'auth:trace:prod:counters:*';
  const keys = await r.keys(pattern); const out = {};
  for (const k of keys) { const svc = k.split(':').pop(); const h = await r.hgetall(k); const o = {}; for (const f in h) o[f] = Number(h[f]); out[svc] = o; }
  return out;
}

async function getRecentRedis(n = 500, stream = 'production') {
  const r = getRedis(); if (!r) return [];
  const key = stream === 'simulation' ? SIM_RECENT_KEY : PROD_RECENT_KEY;
  const a = await r.lrange(key, 0, n - 1);
  return a.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

// Reads legacy auth:trace:recent (pre-6E-6.5, mixed stream) — backfill script only.
async function getRecentRedisMixed(n = 500) {
  const r = getRedis(); if (!r) return [];
  const a = await r.lrange(RECENT_KEY, 0, n - 1);
  return a.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

module.exports = {
  record, recordSimulation, buildEvent, middleware,
  getRecent, getCounters, getAllCounters, getRecentRedis, getRecentRedisMixed,
  normSource, toIdentityMode,
  RECENT_KEY, PROD_RECENT_KEY, SIM_RECENT_KEY,
  PROD_COUNTERS_KEY, SIM_COUNTERS_KEY, COUNTERS_KEY,
};
