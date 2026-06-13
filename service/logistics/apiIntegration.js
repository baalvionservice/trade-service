'use strict';
/**
 * Logistics Optimization Agent — API INTEGRATION LAYER (Prompt 14).
 *
 * PURE: no DB. The single seam through which REAL logistics data feeds (sea-rate
 * APIs, flight-schedule feeds, road-network / ETA services, carrier rate cards) plug
 * into the optimizer WITHOUT touching the engine. It owns:
 *
 *   • REGISTRATION — register lane providers (augment the network graph) and rate
 *     providers (price legs) at runtime; `configure()` bulk-registers from one config
 *     object and returns a single teardown for all of them.
 *   • RESILIENCE   — `callProvider()` wraps a provider call in a bounded in-process
 *     retry with backoff and classifies failures into the schema's FAILURE_KIND so
 *     the optimizer's fallback layer can decide (retry / fall back / abort).
 *   • OBSERVABILITY — `registry()` reports what is wired so the controller can expose
 *     a provider-health descriptor.
 *
 * The built-in network + carrier model remain the deterministic fallback: every
 * provider here is OPTIONAL. With nothing registered the optimizer is fully offline
 * and reproducible; register a provider and the same engine prices against live data.
 */

const net = require('./network');
const rates = require('./carrierRates');
const { FAILURE_KIND, RouteError, DEFAULT_MAX_ATTEMPTS, DEFAULT_BACKOFF_MS } = require('./schema');

const _registered = { lane: [], rate: [] };

/** Register a lane provider (see network.registerLaneProvider). Returns teardown. */
function registerLaneProvider(provider) {
    const off = net.registerLaneProvider(provider);
    _registered.lane.push(provider.name || 'lane-provider');
    return () => { off(); const i = _registered.lane.indexOf(provider.name || 'lane-provider'); if (i >= 0) _registered.lane.splice(i, 1); };
}

/** Register a rate provider (see carrierRates.registerRateProvider). Returns teardown. */
function registerRateProvider(provider) {
    const off = rates.registerRateProvider(provider);
    _registered.rate.push(provider.name || 'rate-provider');
    return () => { off(); const i = _registered.rate.indexOf(provider.name || 'rate-provider'); if (i >= 0) _registered.rate.splice(i, 1); };
}

/**
 * Bulk-register from a config object: { laneProviders: [...], rateProviders: [...] }.
 * Returns one teardown that unregisters everything it registered.
 */
function configure({ laneProviders = [], rateProviders = [] } = {}) {
    const offs = [];
    for (const p of laneProviders) offs.push(registerLaneProvider(p));
    for (const p of rateProviders) offs.push(registerRateProvider(p));
    return () => offs.forEach((off) => off());
}

/** Remove all registered providers — the optimizer reverts to the built-in model. */
function reset() {
    net.clearLaneProviders();
    rates.clearRateProviders();
    _registered.lane.length = 0;
    _registered.rate.length = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Classify an arbitrary thrown error into a FAILURE_KIND for the fallback layer. */
function classifyError(err) {
    if (err instanceof RouteError) return err.kind;
    const msg = String((err && err.message) || err || '').toLowerCase();
    if (/timeout|econn|reset|rate.?limit|temporar|5\d\d|unavailable/.test(msg)) return FAILURE_KIND.TRANSIENT;
    if (/no route|not found|unknown hub|unsupported/.test(msg)) return FAILURE_KIND.NO_ROUTE;
    return FAILURE_KIND.TRANSIENT; // default optimistic — let the retry try once more
}

/**
 * Invoke a provider-backed async function with bounded retry + backoff. Only TRANSIENT
 * failures are retried; VALIDATION / NO_ROUTE abort immediately. On final exhaustion
 * the wrapped error is re-thrown as a RouteError so the optimizer can fall back.
 *
 * @param {Function} fn        async () => result
 * @param {object}   [opts]    { maxAttempts, backoffMs, sleep, label }
 */
async function callProvider(fn, opts = {}) {
    const maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
    const backoffMs = Number(opts.backoffMs) || DEFAULT_BACKOFF_MS;
    const napper = typeof opts.sleep === 'function' ? opts.sleep : sleep;
    const label = opts.label || 'provider';

    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            const kind = classifyError(err);
            if (kind !== FAILURE_KIND.TRANSIENT || attempt === maxAttempts) {
                throw err instanceof RouteError ? err : new RouteError({
                    kind, message: `${label} failed: ${String((err && err.message) || err)}`, detail: { attempts: attempt },
                });
            }
            await napper(backoffMs * attempt); // linear backoff
        }
    }
    throw new RouteError({ kind: FAILURE_KIND.TRANSIENT, message: `${label} exhausted retries`, detail: { lastError: String(lastErr) } });
}

/** Snapshot of what is wired — for a provider-health endpoint. */
function registry() {
    return {
        lane_providers: [..._registered.lane],
        rate_providers: [..._registered.rate],
        lane_provider_count: _registered.lane.length,
        rate_provider_count: _registered.rate.length,
        mode: _registered.lane.length || _registered.rate.length ? 'live-augmented' : 'builtin-only',
    };
}

module.exports = {
    registerLaneProvider,
    registerRateProvider,
    configure,
    reset,
    callProvider,
    classifyError,
    registry,
};
