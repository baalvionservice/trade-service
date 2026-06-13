'use strict';
/**
 * Logistics Optimization Agent — CARRIER SELECTION + LEG PRICING (Prompt 14).
 *
 * PURE: no DB, no network. Given a single lane (from → to, mode, distance, cost_rate)
 * and the shipment weight, this module answers "which carrier should fly this leg,
 * and what does it cost?" — the CARRIER SELECTION concern the prompt asks for, at the
 * per-leg granularity the route builder needs.
 *
 *   1. Eligibility — only carriers whose capability profile serves the lane's MODE.
 *   2. Pricing     — each eligible carrier prices the leg: base_fee + chargeable_kg ×
 *                    rate_per_kg × lane.cost_rate × (distance/1000), nudged by a
 *                    per-carrier multiplier. A pluggable rate provider can override.
 *   3. Selection   — pick the carrier for the leg by a sub-strategy (cheapest /
 *                    fastest-equivalent-by-reliability / balanced).
 *
 * PLUGGABLE: `registerRateProvider()` lets a live rate feed price a leg instead of
 * the built-in model — the API integration seam, mirroring the HS-code duty engine's
 * `registerRateProvider` hook. Providers are consulted first; the built-in carrier
 * model is the deterministic fallback.
 */

const { MODE, num, pct, EMISSION_FACTORS } = require('./schema');

/**
 * Carrier roster — the multi-modal carriers the optimizer can assign to legs. Wider
 * than the freight marketplace's four (which are express/ocean only) because route
 * optimization also assigns rail + road haulage carriers.
 *   modes        — which transport modes this carrier serves
 *   reliability  — baseline 0-100 on-time performance
 *   base_fee     — fixed per-leg handling fee (USD)
 *   rate_per_kg  — per-kg base rate before the lane cost_rate + distance scaling
 *   multiplier   — carrier price posture (a premium carrier > 1, a discounter < 1)
 */
const CARRIERS = Object.freeze({
    'CARR-MAERSK': { name: 'Maersk Line', modes: [MODE.OCEAN], reliability: 93, base_fee: 120, rate_per_kg: 0.04, multiplier: 1.0 },
    'CARR-MSC': { name: 'MSC', modes: [MODE.OCEAN], reliability: 90, base_fee: 100, rate_per_kg: 0.037, multiplier: 0.95 },
    'CARR-DHL': { name: 'DHL', modes: [MODE.EXPRESS, MODE.AIR, MODE.ROAD], reliability: 97, base_fee: 60, rate_per_kg: 0.09, multiplier: 1.1 },
    'CARR-FEDEX': { name: 'FedEx', modes: [MODE.EXPRESS, MODE.AIR, MODE.ROAD], reliability: 96, base_fee: 55, rate_per_kg: 0.088, multiplier: 1.08 },
    'CARR-UPS': { name: 'UPS', modes: [MODE.EXPRESS, MODE.AIR, MODE.ROAD], reliability: 95, base_fee: 50, rate_per_kg: 0.085, multiplier: 1.05 },
    'CARR-DBSCHENKER': { name: 'DB Schenker', modes: [MODE.RAIL, MODE.ROAD, MODE.AIR], reliability: 92, base_fee: 70, rate_per_kg: 0.05, multiplier: 0.98 },
    'CARR-DSV': { name: 'DSV', modes: [MODE.ROAD, MODE.RAIL, MODE.AIR], reliability: 91, base_fee: 65, rate_per_kg: 0.052, multiplier: 0.96 },
});

const ALL_CARRIERS = Object.freeze(Object.keys(CARRIERS));

/** Carriers whose capability profile serves `mode`. */
function carriersForMode(mode) {
    return ALL_CARRIERS.filter((id) => CARRIERS[id].modes.includes(mode));
}

// ── Pluggable rate providers (the API integration seam). ─────────────────────
// A provider is { name, rate(lane, weightKg, carrierId, ctx) -> { cost, transit_days?,
// reliability? } | null }. Consulted first; null/throw ⇒ fall through to built-in.
const _rateProviders = [];
function registerRateProvider(provider) {
    if (!provider || typeof provider.rate !== 'function') {
        throw new Error('registerRateProvider(): provider must implement rate(lane, weightKg, carrierId, ctx)');
    }
    _rateProviders.push(provider);
    return () => {
        const i = _rateProviders.indexOf(provider);
        if (i >= 0) _rateProviders.splice(i, 1);
    };
}
function clearRateProviders() { _rateProviders.length = 0; }

/** Built-in deterministic per-leg price for one carrier on one lane. */
function builtinCost(lane, weightKg, carrierId) {
    const c = CARRIERS[carrierId];
    const distanceFactor = Math.max(0.1, num(lane.distance_km) / 1000);
    const variable = num(weightKg) * c.rate_per_kg * num(lane.cost_rate) * distanceFactor * c.multiplier;
    return Number((c.base_fee * c.multiplier + variable).toFixed(2));
}

/** Estimated CO2 (kg) for a leg: factor[mode] × tonnes × distance_km. */
function legCo2(lane, weightKg) {
    const factor = EMISSION_FACTORS[lane.mode] != null ? EMISSION_FACTORS[lane.mode] : EMISSION_FACTORS[MODE.OCEAN];
    const tonnes = num(weightKg) / 1000;
    return Number((factor * tonnes * num(lane.distance_km)).toFixed(2));
}

/**
 * Price a lane across every eligible carrier. Returns one priced option per carrier:
 *   { carrier, carrier_name, mode, cost, transit_days, distance_km, reliability,
 *     co2_kg, source }
 * A rate provider may override cost/transit/reliability; everything it omits falls
 * back to the built-in model.
 */
function priceLane(lane, weightKg, { ctx = {} } = {}) {
    const eligible = carriersForMode(lane.mode);
    return eligible.map((carrierId) => {
        const c = CARRIERS[carrierId];
        let cost = builtinCost(lane, weightKg, carrierId);
        let transit = num(lane.transit_days);
        let reliability = c.reliability;
        let source = 'builtin';

        for (const prov of _rateProviders) {
            try {
                const quoted = prov.rate(lane, weightKg, carrierId, ctx);
                if (quoted && Number.isFinite(Number(quoted.cost))) {
                    cost = Number(num(quoted.cost).toFixed(2));
                    if (quoted.transit_days != null) transit = Math.max(1, Math.round(num(quoted.transit_days)));
                    if (quoted.reliability != null) reliability = pct(quoted.reliability, reliability);
                    source = prov.name || 'provider';
                    break; // first provider with a real quote wins
                }
            } catch { /* provider miss → keep built-in */ }
        }

        return {
            carrier: carrierId,
            carrier_name: c.name,
            mode: lane.mode,
            cost,
            transit_days: Math.max(1, Math.round(transit)),
            distance_km: num(lane.distance_km),
            reliability: pct(reliability, c.reliability),
            co2_kg: legCo2(lane, weightKg),
            source,
        };
    });
}

/**
 * Select THE carrier for a lane under a sub-strategy and return a single priced
 * option, or null when no carrier serves the lane.
 *   cheapest → lowest cost   fastest → fewest transit days (tie: higher reliability)
 *   balanced → best cost×reliability blend
 */
function selectCarrierForLane(lane, weightKg, subStrategy = 'balanced', opts = {}) {
    const options = priceLane(lane, weightKg, opts);
    if (options.length === 0) return null;

    if (subStrategy === 'cheapest') {
        return [...options].sort((a, b) => a.cost - b.cost || b.reliability - a.reliability)[0];
    }
    if (subStrategy === 'fastest') {
        return [...options].sort((a, b) => a.transit_days - b.transit_days || b.reliability - a.reliability)[0];
    }
    // balanced: min-max blend of cost (lower better) + reliability (higher better).
    const costs = options.map((o) => o.cost);
    const minC = Math.min(...costs); const maxC = Math.max(...costs);
    const span = maxC - minC;
    const scored = options.map((o) => {
        const costScore = span > 0 ? (o.cost - minC) / span : 0;       // 0 best
        const relScore = 1 - o.reliability / 100;                      // 0 best
        return { o, score: 0.6 * costScore + 0.4 * relScore };
    });
    return scored.sort((a, b) => a.score - b.score)[0].o;
}

module.exports = {
    CARRIERS,
    ALL_CARRIERS,
    carriersForMode,
    priceLane,
    selectCarrierForLane,
    builtinCost,
    legCo2,
    registerRateProvider,
    clearRateProviders,
};
