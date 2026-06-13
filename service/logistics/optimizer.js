'use strict';
/**
 * Logistics Optimization Agent — OPTIMIZER (Prompt 14).
 *
 * PURE w.r.t. the database: the orchestrator that composes the whole engine into one
 * call. It does NOT touch persistence (that's logisticsEngine.js one layer up) — it
 * is the deterministic brain:
 *
 *   normalize → validate → resolve hubs → build candidate routes
 *            → (fallback to a synthetic route if the graph yields nothing)
 *            → apply constraints (relaxing progressively if nothing survives)
 *            → score (cost-vs-speed analysis) → cheapest / fastest / balanced
 *
 * Returns the `optimizationResult()` envelope: the ranked candidate set plus the three
 * named picks the prompt requires, the recommended route for the caller's strategy,
 * and a warnings trail (which constraints were relaxed, whether the route is an
 * estimate, which hubs the request resolved to).
 */

const normalize = require('./normalize');
const net = require('./network');
const routeBuilder = require('./routeBuilder');
const scoring = require('./scoring');
const fallback = require('./fallbackRules');
const {
    optimizationResult, RouteError, FAILURE_KIND, STRATEGY, DEFAULT_SCORE_WEIGHTS,
    DEFAULT_MAX_TRANSFERS, DEFAULT_MAX_ROUTES,
} = require('./schema');

/**
 * Run the optimization.
 *
 * @param {object} input  loose optimization request (normalized internally)
 * @param {object} [opts]
 * @param {string}  [opts.strategy]     STRATEGY.* driving the primary `routes` order
 * @param {object}  [opts.weights]      balanced-score weights
 * @param {number}  [opts.maxTransfers] route-search depth (default 2)
 * @param {number}  [opts.maxRoutes]    candidates surfaced (default 12)
 * @param {string}  [opts.generatedAt]  injectable ISO timestamp (deterministic)
 * @returns {object} optimizationResult envelope
 */
function optimize(input = {}, opts = {}) {
    const request = Object.assign(normalize.normalizeRequest(input), { __normalized: true });

    // 1. Validate shape — a malformed request fails identically everywhere; surface once.
    const errors = normalize.baseValidationErrors(request);
    if (errors.length) {
        throw new RouteError({
            kind: FAILURE_KIND.VALIDATION,
            message: `optimization request failed validation (${errors.length} issue${errors.length === 1 ? '' : 's'})`,
            messages: errors,
        });
    }

    const warnings = [];
    const strategy = opts.strategy && Object.values(STRATEGY).includes(opts.strategy)
        ? opts.strategy
        : request.priority || STRATEGY.BALANCED;
    const weights = { ...DEFAULT_SCORE_WEIGHTS, ...(opts.weights || {}) };
    const maxTransfers = opts.maxTransfers != null ? Number(opts.maxTransfers) : DEFAULT_MAX_TRANSFERS;
    const maxRoutes = opts.maxRoutes != null ? Number(opts.maxRoutes) : DEFAULT_MAX_ROUTES;

    // 2. Resolve origin + destination to network hubs.
    const oRes = net.resolveHub(request.origin);
    const dRes = net.resolveHub(request.destination);
    if (!oRes.hub) warnings.push({ code: 'origin_unresolved', message: 'origin did not resolve to a known hub' });
    if (!dRes.hub) warnings.push({ code: 'destination_unresolved', message: 'destination did not resolve to a known hub' });

    const buildOpts = {
        maxTransfers,
        allowedModes: request.allowed_modes,
        currency: request.currency,
        carrierStrategy: 'cheapest',
    };

    // 3. Build candidate routes — fall back to a synthetic direct leg when the graph
    //    (or unresolved geography) yields nothing.
    let candidates = [];
    if (oRes.hub && dRes.hub && oRes.hub !== dRes.hub) {
        try {
            const built = routeBuilder.buildRoutes(oRes.hub, dRes.hub, request.weight_kg, buildOpts);
            candidates = built.routes;
        } catch (err) {
            if (!(err instanceof RouteError) || err.kind !== FAILURE_KIND.NO_ROUTE) throw err;
            warnings.push({ code: 'no_network_route', message: err.message });
        }
    }

    if (candidates.length === 0) {
        // FALLBACK: synthesize a direct estimated route between the resolved hubs (or
        // raw coords if the request carried them).
        const oPoint = oRes.hub || request.origin.coords;
        const dPoint = dRes.hub || request.destination.coords;
        const synth = fallback.syntheticRoute(oPoint, dPoint, request.weight_kg, {
            allowedModes: request.allowed_modes, currency: request.currency,
        });
        if (synth) {
            candidates = [synth];
            warnings.push({ code: 'estimated_route', message: 'no booked lane available — returning a model-estimated direct route' });
        } else {
            throw new RouteError({
                kind: FAILURE_KIND.NO_ROUTE,
                message: 'could not construct any route for this shipment (origin/destination unresolvable)',
                detail: { origin: request.origin, destination: request.destination },
            });
        }
    }

    // 4. Apply hard constraints, relaxing progressively if nothing survives.
    const { routes: constrained, relaxed } = fallback.applyConstraints(candidates, request.constraints);
    for (const key of relaxed) {
        warnings.push({ code: 'constraint_relaxed', message: `constraint '${key}' relaxed — no route satisfied it`, detail: { constraint: key } });
    }

    // 5. Score (cost-vs-speed analysis) + pick cheapest / fastest / balanced.
    const ranked = scoring.rank(constrained, { strategy, weights });
    const routes = ranked.routes.slice(0, Math.max(1, maxRoutes));

    return optimizationResult({
        request,
        strategy: ranked.strategy,
        routes,
        cheapest: ranked.cheapest,
        fastest: ranked.fastest,
        balanced: ranked.balanced,
        recommended: ranked.recommended,
        errors: [],
        warnings,
        weights: ranked.weights,
        generated_at: opts.generatedAt || null,
        resolved: { origin: oRes, destination: dRes },
    });
}

module.exports = {
    optimize,
};
