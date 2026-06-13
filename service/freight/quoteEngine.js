'use strict';
/**
 * Freight QUOTE COMPARISON ENGINE (Prompt 10).
 *
 * The marketplace's price-discovery core. Given one shipment request it fans out to
 * every ELIGIBLE carrier connector (per mode capability), gathers each carrier's
 * normalized quote IN PARALLEL, and ranks the results so the buyer can pick on price,
 * speed, or a balanced composite score. Carriers that fail (validation / transient /
 * permanent) are captured as structured errors rather than aborting the comparison —
 * a single carrier outage never blocks the marketplace.
 *
 * PURE w.r.t. the database: it talks only to the connector layer (which is itself
 * simulated unless a carrier endpoint is configured). Persistence + the booking
 * workflow live one layer up in freightGateway.js.
 *
 * RANKING:
 *   cheapest  → lowest amount
 *   fastest   → fewest transit days
 *   best      → composite of normalized price + speed + reliability (weights tunable)
 * The engine always returns the full ranked list plus the cheapest/fastest/best picks
 * so the caller doesn't re-sort.
 */

const registry = require('./connectors');
const norm = require('./normalize');
const {
    RANK, DEFAULT_RANK_WEIGHTS, DEFAULT_QUOTE_TTL_HOURS, FAILURE_KIND, FreightError,
} = require('./schema');

/** ISO timestamp `ttlHours` from `now` (injectable clock keeps it deterministic). */
function quoteExpiry(now, ttlHours) {
    const base = now instanceof Date ? now : new Date();
    return new Date(base.getTime() + ttlHours * 3600 * 1000).toISOString();
}

/**
 * Min-max normalize a metric to [0,1] where LOWER raw is BETTER (price, transit).
 * A flat field (all equal) maps everything to 0 so it doesn't distort the blend.
 */
function scoreLowerBetter(value, min, max) {
    if (max <= min) return 0;
    return (value - min) / (max - min);
}

/**
 * Rank a set of normalized quotes by a composite "best" score. Returns a NEW array
 * (immutable) of { ...quote, score } sorted best-first. Lower score = better.
 */
function rankBest(quotes, weights = DEFAULT_RANK_WEIGHTS) {
    if (quotes.length === 0) return [];
    const prices = quotes.map((q) => q.amount);
    const transits = quotes.map((q) => q.transit_days);
    const minP = Math.min(...prices); const maxP = Math.max(...prices);
    const minT = Math.min(...transits); const maxT = Math.max(...transits);
    return quotes
        .map((q) => {
            const priceScore = scoreLowerBetter(q.amount, minP, maxP);
            const speedScore = scoreLowerBetter(q.transit_days, minT, maxT);
            // reliability is higher-better → invert to lower-better.
            const relScore = 1 - (q.reliability != null ? q.reliability : 90) / 100;
            const score = weights.price * priceScore + weights.speed * speedScore + weights.reliability * relScore;
            return { ...q, score: Number(score.toFixed(6)) };
        })
        .sort((a, b) => a.score - b.score || a.amount - b.amount);
}

/** Sort helpers for the single-axis strategies (immutable). */
const byCheapest = (quotes) => [...quotes].sort((a, b) => a.amount - b.amount || a.transit_days - b.transit_days);
const byFastest = (quotes) => [...quotes].sort((a, b) => a.transit_days - b.transit_days || a.amount - b.amount);

/**
 * Run the comparison. Fans out across eligible carriers, collects normalized quotes,
 * and ranks them.
 *
 * @param {object} requestInput  loose shipment request (normalized internally)
 * @param {object} [opts]
 * @param {string} [opts.rank]        RANK.* — which ranking drives `ranked` (default BEST)
 * @param {object} [opts.weights]     composite-score weights for RANK.BEST
 * @param {number} [opts.ttlHours]    quote validity window
 * @param {Date}   [opts.now]         injectable clock (deterministic ETA + expiry)
 * @param {Array}  [opts.connectors]  override the eligible connector set (tests)
 * @param {object} [opts.connectorOpts] per-quote ctx forwarded to each connector
 * @returns {Promise<{ request, quotes, ranked, cheapest, fastest, best, errors, carriers_quoted, carriers_failed }>}
 */
async function compareQuotes(requestInput, opts = {}) {
    const request = Object.assign(norm.normalizeShipmentRequest(requestInput), { __normalized: true });
    const baseErrors = norm.baseValidationErrors(request);
    if (baseErrors.length) {
        // A structurally invalid request fails the same way for every carrier — surface
        // it once as a validation error instead of fanning out N identical rejections.
        throw new FreightError({
            kind: FAILURE_KIND.VALIDATION,
            message: `shipment request failed validation (${baseErrors.length} issue${baseErrors.length === 1 ? '' : 's'})`,
            messages: baseErrors,
        });
    }

    const ttlHours = Number(opts.ttlHours) || DEFAULT_QUOTE_TTL_HOURS;
    const now = opts.now instanceof Date ? opts.now : new Date();
    const validUntil = quoteExpiry(now, ttlHours);

    const connectors = Array.isArray(opts.connectors) && opts.connectors.length
        ? opts.connectors
        : registry.eligibleConnectors(request);

    // Fan out — each carrier quotes independently; one failure never sinks the rest.
    const settled = await Promise.all(connectors.map(async (connector) => {
        try {
            const { quote } = await connector.quote(request, { ...opts.connectorOpts, now, validUntil });
            return { ok: true, quote };
        } catch (err) {
            const fe = err instanceof FreightError ? err : new FreightError({ kind: FAILURE_KIND.TRANSIENT, message: String(err && err.message || err), carrier: connector.carrier });
            return {
                ok: false,
                error: { carrier: connector.carrier, kind: fe.kind, code: fe.code || null, message: fe.message, messages: fe.messages || [] },
            };
        }
    }));

    const quotes = settled.filter((s) => s.ok).map((s) => s.quote);
    const errors = settled.filter((s) => !s.ok).map((s) => s.error);

    const ranked = rankBest(quotes, opts.weights || DEFAULT_RANK_WEIGHTS);
    const cheapestList = byCheapest(quotes);
    const fastestList = byFastest(quotes);

    const wanted = RANK[String(opts.rank || '').toUpperCase()] || RANK.BEST;
    const primaryOrder = wanted === RANK.CHEAPEST ? cheapestList
        : wanted === RANK.FASTEST ? fastestList
            : ranked;

    return {
        request,
        rank: wanted,
        quotes,
        ranked: primaryOrder,
        cheapest: cheapestList[0] || null,
        fastest: fastestList[0] || null,
        best: ranked[0] || null,
        errors,
        carriers_quoted: quotes.map((q) => q.carrier),
        carriers_failed: errors.map((e) => e.carrier),
        valid_until: validUntil,
    };
}

module.exports = {
    compareQuotes,
    rankBest,
    byCheapest,
    byFastest,
    scoreLowerBetter,
    quoteExpiry,
};
