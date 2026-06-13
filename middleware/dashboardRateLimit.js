'use strict';
/**
 * Trade Operations Dashboard — per-caller rate limiters (War Room 4, Prompt 3).
 *
 * The app already applies a global IP limiter (middleware/rateLimit.js). These
 * are tighter, route-scoped limiters keyed by the authenticated user (falling
 * back to IP), so a single account cannot hammer the read APIs or spam the
 * comment endpoint. Same safe-fallback contract as rateLimit.js: a no-op shim
 * when express-rate-limit is not installed, so the service never hard-depends
 * on it.
 */
let expressRateLimit;
try { expressRateLimit = require('express-rate-limit'); } catch { /* no-op fallback below */ }

function resolveFactory() {
    if (!expressRateLimit) return null;
    return typeof expressRateLimit === 'function'
        ? expressRateLimit
        : (expressRateLimit.default || expressRateLimit.rateLimit || expressRateLimit);
}

// Key by authenticated user id when present, else fall back to IP.
const keyGenerator = (req) => (req.auth && req.auth.userId) || req.ip;

function makeLimiter({ windowMs, max, code, message }) {
    const factory = resolveFactory();
    if (!factory) return (_req, _res, next) => next();
    return factory({
        windowMs,
        max,
        keyGenerator,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: { code, message } },
    });
}

// Reads: generous (dashboards poll). 240 req / minute / user.
const readLimiter = makeLimiter({
    windowMs: 60_000,
    max: Number(process.env.DASHBOARD_READ_RATE_MAX || 240),
    code: 'RATE_LIMITED',
    message: 'Too many dashboard requests; slow down',
});

// Comment writes: strict. 20 comments / minute / user.
const commentLimiter = makeLimiter({
    windowMs: 60_000,
    max: Number(process.env.DASHBOARD_COMMENT_RATE_MAX || 20),
    code: 'COMMENT_RATE_LIMITED',
    message: 'Too many comments; slow down',
});

module.exports = { readLimiter, commentLimiter };
