'use strict';
/**
 * Logistics Optimization Agent — FALLBACK RULES (Prompt 14).
 *
 * PURE: no DB, no network. The resilience layer. When the lane network can't produce
 * a route — an exotic origin/destination not in the graph, a provider outage, or a
 * constraint set nothing satisfies — these rules keep the optimizer answering instead
 * of hard-failing:
 *
 *   1. SYNTHETIC DIRECT LANE — when the route builder finds no path, synthesize a
 *      single direct great-circle leg between the two hubs (or two raw coordinates)
 *      using a mode chosen by distance, priced by the built-in carrier model, and
 *      flagged `estimated: true` so the caller knows it is a model estimate, not a
 *      booked lane.
 *
 *   2. CONSTRAINT RELAXATION — when every real route violates the caller's hard
 *      constraints (max_cost / max_transit / min_reliability), progressively relax
 *      the least-critical constraint and report which ones were dropped, rather than
 *      returning an empty result.
 *
 *   3. DEFAULT MODE SELECTION — pick a sensible default transport mode from distance
 *      when the request constrains nothing.
 */

const { MODE, normalizedRoute, num } = require('./schema');
const net = require('./network');
const rates = require('./carrierRates');

// Distance thresholds (km) → default mode when the caller doesn't constrain modes.
const SHORT_HAUL_KM = 800;    // ≤ → road
const REGIONAL_KM = 4000;     // ≤ → rail/road land, else ocean/air by preference

/** Choose a default mode from a great-circle distance + allowed-mode filter. */
function defaultModeForDistance(distanceKm, allowedModes = []) {
    const allow = Array.isArray(allowedModes) && allowedModes.length ? new Set(allowedModes) : null;
    const ok = (m) => !allow || allow.has(m);
    if (distanceKm <= SHORT_HAUL_KM && ok(MODE.ROAD)) return MODE.ROAD;
    if (distanceKm <= REGIONAL_KM && ok(MODE.RAIL)) return MODE.RAIL;
    if (ok(MODE.OCEAN)) return MODE.OCEAN;        // long-haul default: cheapest
    if (ok(MODE.AIR)) return MODE.AIR;
    if (ok(MODE.ROAD)) return MODE.ROAD;
    if (ok(MODE.RAIL)) return MODE.RAIL;
    return MODE.OCEAN;
}

// Synthetic-lane transit model: rough km/day throughput per mode (door-to-door).
const KM_PER_DAY = Object.freeze({
    [MODE.EXPRESS]: 4000, [MODE.AIR]: 3000, [MODE.ROAD]: 600, [MODE.RAIL]: 700, [MODE.OCEAN]: 650,
});

/**
 * Synthesize a single direct ESTIMATED route between two points. Accepts either hub
 * codes (preferred — uses their coords) or raw [lat,lon] coordinate pairs. Returns a
 * normalized route flagged estimated, or null when geography can't be resolved.
 */
function syntheticRoute(origin, destination, weightKg, { allowedModes = [], currency = 'USD' } = {}) {
    const oHub = net.getHub(origin);
    const dHub = net.getHub(destination);
    const oCoords = oHub ? oHub.coords : (Array.isArray(origin) ? origin : null);
    const dCoords = dHub ? dHub.coords : (Array.isArray(destination) ? destination : null);
    if (!oCoords || !dCoords) return null;

    const distance = net.haversineKm(oCoords, dCoords);
    if (distance <= 0) return null;

    const mode = defaultModeForDistance(distance, allowedModes);
    const transit = Math.max(1, Math.round(distance / (KM_PER_DAY[mode] || 650)));

    // Price the synthetic lane via the built-in carrier model (cost_rate=1 baseline).
    const lane = { from: oHub ? origin : 'ORIG', to: dHub ? destination : 'DEST', mode, distance_km: distance, transit_days: transit, cost_rate: 1 };
    const picked = rates.selectCarrierForLane(lane, weightKg, 'cheapest');

    const leg = {
        from: lane.from,
        to: lane.to,
        mode,
        carrier: picked ? picked.carrier : null,
        carrier_name: picked ? picked.carrier_name : 'estimated',
        distance_km: distance,
        transit_days: picked ? picked.transit_days : transit,
        cost: picked ? picked.cost : Number((num(weightKg) * 0.1 * (distance / 1000)).toFixed(2)),
        reliability: picked ? picked.reliability : 80,
        co2_kg: rates.legCo2(lane, weightKg),
        estimated: true,
    };

    try {
        return normalizedRoute([leg], { currency, id: `RT-EST-${lane.from}-${lane.to}-${mode}` });
    } catch {
        return null;
    }
}

/**
 * Apply hard constraints to a candidate set, RELAXING progressively when nothing
 * survives. Reliability is relaxed first (softest), then transit, then cost (hardest
 * — a budget overrun is the most consequential to silently ignore).
 *
 * @returns {{ routes, relaxed }} surviving routes + the list of dropped constraints.
 */
function applyConstraints(routes, constraints = {}) {
    if (!Array.isArray(routes) || routes.length === 0) return { routes: [], relaxed: [] };
    const c = constraints || {};
    const checks = [
        { key: 'min_reliability', test: (r) => c.min_reliability == null || r.reliability >= c.min_reliability },
        { key: 'max_transit_days', test: (r) => c.max_transit_days == null || r.total_transit_days <= c.max_transit_days },
        { key: 'max_cost', test: (r) => c.max_cost == null || r.total_cost <= c.max_cost },
    ];

    // Relaxation order: drop reliability first, then transit, then cost.
    const relaxOrder = ['min_reliability', 'max_transit_days', 'max_cost'];
    let active = checks.filter((chk) => c[chk.key] != null);
    const relaxed = [];

    let surviving = routes.filter((r) => active.every((chk) => chk.test(r)));
    while (surviving.length === 0 && active.length > 0) {
        const dropKey = relaxOrder.find((k) => active.some((chk) => chk.key === k));
        if (!dropKey) break;
        relaxed.push(dropKey);
        active = active.filter((chk) => chk.key !== dropKey);
        surviving = routes.filter((r) => active.every((chk) => chk.test(r)));
    }

    // If even with all constraints relaxed nothing matched (impossible since active
    // empties to all-pass), fall back to the full set.
    if (surviving.length === 0) surviving = [...routes];
    return { routes: surviving, relaxed };
}

module.exports = {
    defaultModeForDistance,
    syntheticRoute,
    applyConstraints,
    SHORT_HAUL_KM,
    REGIONAL_KM,
    KM_PER_DAY,
};
