'use strict';
const config = require('../config/appConfig');

// express-rate-limit is CodeQL-recognized and handles distributed-safe counters.
// The legacy in-memory Map is unbounded (no eviction for dead IPs) and not cluster-safe.
let expressRateLimit;
try { expressRateLimit = require('express-rate-limit'); } catch { /* falls back below */ }

/**
 * Returns an express-rate-limit middleware (preferred) or a no-op shim when the
 * package is not yet installed.  Install: add "express-rate-limit" to package.json
 * dependencies and run `pnpm install --filter trade-service`.
 *
 * Limits are generous (default 120 req/min per IP) to avoid blocking legitimate traffic.
 * Set RATE_LIMIT_IP_MAX in env to tune.
 */
module.exports = () => {
    const max = config.security?.ipRateLimit || 120;
    if (expressRateLimit) {
        const rateLimit = typeof expressRateLimit === 'function'
            ? expressRateLimit
            : (expressRateLimit.default || expressRateLimit.rateLimit || expressRateLimit);
        return rateLimit({
            windowMs: 60_000,
            max,
            standardHeaders: true,
            legacyHeaders: false,
            message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
        });
    }
    // Fallback: no-op shim — rate limiting disabled until package is installed.
    console.warn('[rateLimit] express-rate-limit not installed; rate limiting is DISABLED. Run: pnpm add express-rate-limit --filter trade-service');
    return (_req, _res, next) => next();
};
