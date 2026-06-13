'use strict';
/**
 * Logistics Optimization Agent — VOCABULARY + FACTORIES (War Room 4, Prompt 14).
 *
 * PURE: no DB, no I/O, no network. The single stable vocabulary every module in the
 * optimizer speaks — the transport MODE taxonomy, the route STRATEGY ladder
 * (cheapest / fastest / balanced — the three outputs the prompt asks for), the
 * default SCORE weights the scoring engine blends, the FAILURE_KIND taxonomy that
 * drives the fallback decisions, and the `normalizedLeg()` / `normalizedRoute()` /
 * `optimizationResult()` / `routeError()` factories every other module funnels
 * through so a route is shape-identical regardless of which provider produced its
 * legs.
 *
 * The distinction from the Freight Marketplace (Prompt 10): that engine compares
 * single-leg carrier QUOTES for one origin→destination lane. THIS engine optimizes
 * end-to-end multi-leg ROUTES through a lane network — each leg potentially a
 * different carrier + mode + hub — and scores whole routes on cost vs speed.
 *
 * A NORMALIZED LEG — one carrier-served hop between two hubs:
 *   {
 *     from, to            — hub codes (e.g. 'CNSHA' → 'NLRTM')
 *     mode                — MODE.* the leg travels
 *     carrier             — selected carrier id (or null when estimated)
 *     carrier_name        — display name
 *     distance_km         — lane distance
 *     transit_days        — door-to-door business days for this leg
 *     cost                — leg cost in `currency`
 *     currency
 *     reliability         — 0-100 on-time performance
 *     co2_kg              — estimated emissions for the leg
 *     estimated           — true when synthesized by the fallback layer (no real lane/rate)
 *   }
 *
 * A NORMALIZED ROUTE — an end-to-end origin→destination path the optimizer ranks:
 *   {
 *     id                  — deterministic route id (hub path signature)
 *     legs                — [normalizedLeg]
 *     hops                — number of legs
 *     path                — [hub codes] the route traverses
 *     modes               — distinct modes used
 *     carriers            — distinct carriers used
 *     total_cost          — Σ leg cost
 *     total_transit_days  — Σ leg transit + per-transfer dwell
 *     total_distance_km   — Σ leg distance
 *     reliability         — compounded route reliability (product of leg reliabilities)
 *     co2_kg              — Σ leg emissions
 *     currency
 *     transfers           — number of hub transfers (hops - 1)
 *     estimated           — true when any leg was synthesized
 *     score               — composite balanced score (filled by the scoring engine; lower = better)
 *     score_breakdown     — { cost, speed, reliability } normalized sub-scores
 *   }
 */

// ── Transport modes (mirrors the freight marketplace taxonomy). ──────────────
const MODE = Object.freeze({
    EXPRESS: 'express', // time-definite door-to-door parcel/express
    AIR: 'air',         // air freight
    OCEAN: 'ocean',     // sea / container freight
    ROAD: 'road',       // ground / road haulage
    RAIL: 'rail',       // rail freight (intercontinental land bridge / domestic)
});
const VALID_MODES = Object.freeze(Object.values(MODE));

// Relative speed ordering — used by the fallback heuristic when a lane has no
// measured transit. Lower = faster.
const MODE_SPEED_RANK = Object.freeze({
    [MODE.EXPRESS]: 1, [MODE.AIR]: 2, [MODE.ROAD]: 3, [MODE.RAIL]: 4, [MODE.OCEAN]: 5,
});

// ── Route STRATEGY ladder — the three outputs the prompt requires. ───────────
const STRATEGY = Object.freeze({
    CHEAPEST: 'cheapest',  // minimize total_cost
    FASTEST: 'fastest',    // minimize total_transit_days
    BALANCED: 'balanced',  // composite of cost + speed + reliability (the recommended pick)
});
const VALID_STRATEGIES = Object.freeze(Object.values(STRATEGY));

// Default composite-score weights for STRATEGY.BALANCED. Tunable per-request without
// code changes via optimizer options. Sum need not be 1 — the score is relative
// WITHIN a request (min-max normalized per candidate set).
const DEFAULT_SCORE_WEIGHTS = Object.freeze({ cost: 0.45, speed: 0.35, reliability: 0.20 });

// ── Failure taxonomy. Drives the fallback (optimizer) + retry (api layer). ───
const FAILURE_KIND = Object.freeze({
    // The optimization request itself is structurally invalid. Never retried, never
    // worth a fallback — the same bad request fails identically everywhere.
    VALIDATION: 'validation',
    // A provider (lane / rate) failed in a way that may succeed on retry: timeout,
    // 5xx, rate-limit. Retried in-process; on exhaustion the engine falls back to
    // its built-in network/rate model rather than aborting the whole optimization.
    TRANSIENT: 'transient',
    // No route could be constructed for this shipment even after fallback (no lane,
    // no eligible carrier, constraints unsatisfiable). Terminal for the request.
    NO_ROUTE: 'no_route',
});

// ── Per-transfer dwell time (days) added at each hub a route transfers through —
//    handling / consolidation / customs touch between legs. ───────────────────
const TRANSFER_DWELL_DAYS = 1;

// ── CO2 emission factors (kg CO2 per tonne-km) per mode. Order-of-magnitude
//    industry figures; the optimizer treats CO2 as an informational dimension. ─
const EMISSION_FACTORS = Object.freeze({
    [MODE.OCEAN]: 0.012,
    [MODE.RAIL]: 0.028,
    [MODE.ROAD]: 0.105,
    [MODE.AIR]: 0.55,
    [MODE.EXPRESS]: 0.6,
});

// ── Engine version (stamped on every persisted optimization for audit/replay). ─
const ENGINE_VERSION = 'logistics-optimization@1.0.0';

// Defaults for the route search + provider layer.
const DEFAULT_MAX_TRANSFERS = 2;   // direct + up to 2 intermediate hubs
const DEFAULT_MAX_ROUTES = 12;     // cap on candidate routes surfaced
const DEFAULT_MAX_ATTEMPTS = 3;    // provider in-process retry budget
const DEFAULT_BACKOFF_MS = 200;

/** Coerce to a finite non-negative number (0 on garbage). */
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Clamp a 0-100 reliability/percentage value. */
function pct(v, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, n));
}

/**
 * Build a NORMALIZED LEG — the single shape every lane/carrier hop funnels through.
 * @returns {object} a frozen normalized leg
 */
function normalizedLeg(leg = {}) {
    const {
        from, to,
        mode = MODE.OCEAN,
        carrier = null,
        carrier_name = null,
        distance_km = 0,
        transit_days = 0,
        cost = 0,
        currency = 'USD',
        reliability = 90,
        co2_kg = 0,
        estimated = false,
    } = leg;

    if (!from || !to) throw new Error('normalizedLeg(): from + to hub codes are required');
    if (!VALID_MODES.includes(mode)) throw new Error(`normalizedLeg(): unknown mode '${mode}'`);

    return Object.freeze({
        from: String(from),
        to: String(to),
        mode,
        carrier: carrier != null ? String(carrier) : null,
        carrier_name: carrier_name != null ? String(carrier_name) : null,
        distance_km: num(distance_km),
        transit_days: Math.max(0, Math.round(num(transit_days))),
        cost: Number(num(cost).toFixed(2)),
        currency: String(currency || 'USD').toUpperCase().slice(0, 8),
        reliability: pct(reliability, 90),
        co2_kg: Number(num(co2_kg).toFixed(2)),
        estimated: !!estimated,
    });
}

/**
 * Build a NORMALIZED ROUTE from a set of legs — aggregates cost / transit / distance
 * / reliability / emissions. The composite `score` is filled later by the scoring
 * engine (it needs the whole candidate set to min-max normalize).
 * @returns {object} a frozen normalized route (score = null until scored)
 */
function normalizedRoute(legs = [], opts = {}) {
    const list = (Array.isArray(legs) ? legs : []).map(normalizedLeg);
    if (list.length === 0) throw new Error('normalizedRoute(): at least one leg is required');

    const currency = opts.currency || list[0].currency || 'USD';
    const path = [list[0].from, ...list.map((l) => l.to)];
    const transfers = Math.max(0, list.length - 1);
    const dwellDays = transfers * (opts.transferDwellDays != null ? opts.transferDwellDays : TRANSFER_DWELL_DAYS);

    const totalCost = list.reduce((s, l) => s + l.cost, 0);
    const legTransit = list.reduce((s, l) => s + l.transit_days, 0);
    const totalDistance = list.reduce((s, l) => s + l.distance_km, 0);
    const totalCo2 = list.reduce((s, l) => s + l.co2_kg, 0);
    // Route reliability = product of per-leg reliabilities (each weak link drags it down).
    const reliability = list.reduce((r, l) => r * (l.reliability / 100), 1) * 100;

    const modes = [...new Set(list.map((l) => l.mode))];
    const carriers = [...new Set(list.map((l) => l.carrier).filter(Boolean))];
    const id = opts.id || `RT-${path.join('-')}-${modes.join('+')}`;

    return Object.freeze({
        id,
        legs: Object.freeze(list),
        hops: list.length,
        path: Object.freeze(path),
        modes: Object.freeze(modes),
        carriers: Object.freeze(carriers),
        total_cost: Number(totalCost.toFixed(2)),
        total_transit_days: Math.round(legTransit + dwellDays),
        total_distance_km: Number(totalDistance.toFixed(2)),
        reliability: Number(reliability.toFixed(2)),
        co2_kg: Number(totalCo2.toFixed(2)),
        currency: String(currency).toUpperCase().slice(0, 8),
        transfers,
        estimated: list.some((l) => l.estimated),
        score: opts.score != null ? Number(opts.score) : null,
        score_breakdown: opts.score_breakdown || null,
    });
}

/**
 * Build the OPTIMIZATION RESULT envelope — the single shape the engine + controller
 * return. Carries the full ranked candidate set plus the three strategy picks so the
 * caller never re-sorts.
 */
function optimizationResult(out = {}) {
    return Object.freeze({
        request: out.request || null,
        strategy: VALID_STRATEGIES.includes(out.strategy) ? out.strategy : STRATEGY.BALANCED,
        routes: Object.freeze(Array.isArray(out.routes) ? out.routes : []),
        cheapest: out.cheapest || null,
        fastest: out.fastest || null,
        balanced: out.balanced || null,
        recommended: out.recommended || null,
        errors: Object.freeze(Array.isArray(out.errors) ? out.errors : []),
        warnings: Object.freeze(Array.isArray(out.warnings) ? out.warnings : []),
        weights: out.weights || DEFAULT_SCORE_WEIGHTS,
        engine_version: ENGINE_VERSION,
        generated_at: out.generated_at || null,
    });
}

/**
 * A structured optimization error. `kind` decides whether the provider layer retries
 * (TRANSIENT) and whether the optimizer falls back to its built-in model or aborts.
 */
class RouteError extends Error {
    constructor({ kind, message: msg, detail = {}, messages = [] } = {}) {
        super(msg || `logistics ${kind || 'error'}`);
        this.name = 'RouteError';
        this.kind = Object.values(FAILURE_KIND).includes(kind) ? kind : FAILURE_KIND.TRANSIENT;
        this.detail = detail || {};
        this.messages = Array.isArray(messages) ? messages : [];
        this.retryable = this.kind === FAILURE_KIND.TRANSIENT;
    }
}

function routeError(kind, msg, extra = {}) {
    return new RouteError({ kind, message: msg, ...extra });
}

module.exports = {
    MODE,
    VALID_MODES,
    MODE_SPEED_RANK,
    STRATEGY,
    VALID_STRATEGIES,
    DEFAULT_SCORE_WEIGHTS,
    FAILURE_KIND,
    TRANSFER_DWELL_DAYS,
    EMISSION_FACTORS,
    ENGINE_VERSION,
    DEFAULT_MAX_TRANSFERS,
    DEFAULT_MAX_ROUTES,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_BACKOFF_MS,
    num,
    pct,
    normalizedLeg,
    normalizedRoute,
    optimizationResult,
    RouteError,
    routeError,
};
