'use strict';
/**
 * Logistics Optimization Agent — SCORING ENGINE (Prompt 14).
 *
 * PURE: no DB, no network. The COST-VS-SPEED ANALYSIS core. Given a set of candidate
 * routes it min-max normalizes each route's cost, transit and reliability WITHIN the
 * set (so the score is comparative, not absolute), blends them into one composite
 * BALANCED score per the weight profile, and returns the three picks the prompt
 * requires:
 *
 *   cheapest  → lowest total_cost
 *   fastest   → fewest total_transit_days
 *   balanced  → best composite score (the recommended route)
 *
 * Every route is returned carrying its `score` (lower = better) and a
 * `score_breakdown` of its normalized cost / speed / reliability sub-scores, so the
 * caller can see WHY one route beat another — the analysis, not just the verdict.
 */

const { STRATEGY, DEFAULT_SCORE_WEIGHTS, normalizedRoute } = require('./schema');

/**
 * Min-max normalize a metric to [0,1] where LOWER raw is BETTER (cost, transit). A
 * flat field (all equal) maps to 0 so a non-discriminating axis doesn't distort the
 * blend.
 */
function scoreLowerBetter(value, min, max) {
    if (max <= min) return 0;
    return (value - min) / (max - min);
}

/**
 * Apply the composite BALANCED score to every route. Returns a NEW array (immutable)
 * of routes each re-built with { score, score_breakdown } populated, sorted best
 * (lowest score) first. Cost + speed are lower-better; reliability is higher-better
 * so it is inverted before weighting.
 */
function scoreRoutes(routes, weights = DEFAULT_SCORE_WEIGHTS) {
    if (!Array.isArray(routes) || routes.length === 0) return [];
    const w = { ...DEFAULT_SCORE_WEIGHTS, ...(weights || {}) };

    const costs = routes.map((r) => r.total_cost);
    const transits = routes.map((r) => r.total_transit_days);
    const minC = Math.min(...costs); const maxC = Math.max(...costs);
    const minT = Math.min(...transits); const maxT = Math.max(...transits);

    return routes
        .map((r) => {
            const costScore = scoreLowerBetter(r.total_cost, minC, maxC);
            const speedScore = scoreLowerBetter(r.total_transit_days, minT, maxT);
            const relScore = 1 - (r.reliability != null ? r.reliability : 90) / 100; // invert → lower better
            const score = Number((w.cost * costScore + w.speed * speedScore + w.reliability * relScore).toFixed(6));
            const breakdown = {
                cost: Number(costScore.toFixed(4)),
                speed: Number(speedScore.toFixed(4)),
                reliability: Number(relScore.toFixed(4)),
            };
            // Rebuild via the factory so the score rides INSIDE the frozen route object.
            return normalizedRoute([...r.legs], {
                id: r.id, currency: r.currency, score, score_breakdown: breakdown,
            });
        })
        .sort((a, b) => a.score - b.score || a.total_cost - b.total_cost);
}

/** Cheapest-first ordering (tie: faster, then more reliable). Immutable. */
const byCheapest = (routes) => [...routes].sort(
    (a, b) => a.total_cost - b.total_cost || a.total_transit_days - b.total_transit_days || b.reliability - a.reliability,
);

/** Fastest-first ordering (tie: cheaper, then more reliable). Immutable. */
const byFastest = (routes) => [...routes].sort(
    (a, b) => a.total_transit_days - b.total_transit_days || a.total_cost - b.total_cost || b.reliability - a.reliability,
);

/**
 * Rank a candidate set and produce the full analysis: the scored list plus the three
 * named picks. `strategy` selects which ordering drives the primary `routes` list the
 * caller iterates (default BALANCED).
 *
 * @returns {{ strategy, routes, cheapest, fastest, balanced, recommended, weights }}
 */
function rank(routes, { strategy = STRATEGY.BALANCED, weights = DEFAULT_SCORE_WEIGHTS } = {}) {
    const scored = scoreRoutes(routes, weights);          // balanced order
    const cheapestList = byCheapest(scored);
    const fastestList = byFastest(scored);

    const cheapest = cheapestList[0] || null;
    const fastest = fastestList[0] || null;
    const balanced = scored[0] || null;

    const wanted = Object.values(STRATEGY).includes(strategy) ? strategy : STRATEGY.BALANCED;
    const primary = wanted === STRATEGY.CHEAPEST ? cheapestList
        : wanted === STRATEGY.FASTEST ? fastestList
            : scored;
    const recommended = wanted === STRATEGY.CHEAPEST ? cheapest
        : wanted === STRATEGY.FASTEST ? fastest
            : balanced;

    return {
        strategy: wanted,
        routes: primary,
        cheapest,
        fastest,
        balanced,
        recommended,
        weights: { ...DEFAULT_SCORE_WEIGHTS, ...(weights || {}) },
    };
}

module.exports = {
    scoreLowerBetter,
    scoreRoutes,
    byCheapest,
    byFastest,
    rank,
};
