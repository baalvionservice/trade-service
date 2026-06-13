'use strict';
/**
 * HS Code Intelligence Engine — REPORT builder (Prompt 7).
 *
 * PURE: no DB, no I/O. Fuses the candidates from the three producers (search,
 * AI, fallback) into the single ranked `hs_suggestion_report` the prompt asks
 * for, then attaches the compliance flags for the WINNING code and the duty
 * estimate hook.
 *
 * Fusion rules:
 *   • candidates are merged by hs_code; the merged confidence is the MAX across
 *     producers, but a code corroborated by more than one method gets a small
 *     agreement bonus (search + AI agreeing is a stronger signal than either).
 *   • the fallback engine only contributes codes not already found by search/AI
 *     (it is the safety net, not a competitor).
 *   • suggestions are sorted confidence-desc; the top one is `best`.
 *
 * hs_suggestion_report shape:
 * {
 *   engine_version, generated_at,
 *   query: { product, destination_country, origin_country, customs_value, currency },
 *   suggestions: [ suggestion + { methods:[...] } ],   // ranked
 *   best: suggestion | null,
 *   compliance_flags: [ flag ],                          // for `best`
 *   duty_estimate: {...} | null,                         // for `best`
 *   summary: { candidate_count, best_confidence, best_band, needs_review, blocking }
 * }
 */

const norm = require('./normalize');
const {
    METHOD, REVIEW_THRESHOLD, band, clampConfidence, suggestion,
} = require('./schema');

const ENGINE_VERSION = '1.0.0';
const AGREEMENT_BONUS = 6; // per extra method that corroborates a code (capped)
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Producer precedence when methods disagree on metadata — prefer the richest.
const METHOD_PRIORITY = { [METHOD.EXACT]: 4, [METHOD.AI]: 3, [METHOD.SEARCH]: 2, [METHOD.FALLBACK]: 1, [METHOD.MANUAL]: 5 };

/**
 * Merge candidate suggestions from multiple producers by hs_code.
 * @param {object[]} candidates suggestion()s from any producer
 * @returns {object[]} merged, ranked suggestions (each carries `methods[]`)
 */
function fuse(candidates) {
    const byCode = new Map();
    for (const c of candidates) {
        if (!c || !c.hs_code) continue;
        const cur = byCode.get(c.hs_code);
        if (!cur) {
            byCode.set(c.hs_code, {
                best: c,
                methods: new Set([c.method]),
                matched_on: new Set(c.matched_on || []),
                maxConfidence: c.confidence,
            });
            continue;
        }
        cur.methods.add(c.method);
        for (const m of c.matched_on || []) cur.matched_on.add(m);
        cur.maxConfidence = Math.max(cur.maxConfidence, c.confidence);
        // Keep the metadata from the higher-priority producer.
        if ((METHOD_PRIORITY[c.method] || 0) > (METHOD_PRIORITY[cur.best.method] || 0)) {
            cur.best = c;
        }
    }

    const merged = [];
    for (const { best, methods, matched_on, maxConfidence } of byCode.values()) {
        const extraMethods = Math.max(0, methods.size - 1);
        const confidence = clampConfidence(maxConfidence + Math.min(extraMethods * AGREEMENT_BONUS, 12));
        merged.push({
            ...suggestion({
                hs_code: best.hs_code,
                description: best.description,
                chapter: best.chapter,
                heading: best.heading,
                category: best.category,
                method: best.method,
                confidence,
                matched_on: [...matched_on].slice(0, 10),
                national_code: best.national_code,
                country: best.country,
                source: best.source,
            }),
            methods: [...methods],
        });
    }

    merged.sort((a, b) => b.confidence - a.confidence
        || (METHOD_PRIORITY[b.method] || 0) - (METHOD_PRIORITY[a.method] || 0));
    return merged;
}

/**
 * Build the full hs_suggestion_report.
 *
 * @param {object} input
 * @param {object} input.query                 { product, destinationCountry, originCountry, customsValue, currency }
 * @param {object[]} input.candidates          raw candidates from producers
 * @param {object[]} [input.complianceFlags]   flags for the winning code
 * @param {object} [input.dutyEstimate]        duty estimate for the winning code
 * @param {boolean} [input.blocking=false]     compliance.isBlocking(flags)
 * @param {Date} [input.now]
 * @returns {object} hs_suggestion_report
 */
function build({ query = {}, candidates = [], complianceFlags = [], dutyEstimate = null, blocking = false, limit = 5, now = new Date() } = {}) {
    const fused = fuse(candidates).slice(0, limit);
    const best = fused[0] || null;
    const bestConfidence = best ? best.confidence : 0;

    return {
        engine_version: ENGINE_VERSION,
        generated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
        query: {
            product: query.product || null,
            destination_country: norm.normalizeCountry(query.destinationCountry),
            origin_country: norm.normalizeCountry(query.originCountry),
            customs_value: query.customsValue == null ? null : round2(query.customsValue),
            currency: query.currency || null,
        },
        suggestions: fused,
        best,
        compliance_flags: complianceFlags,
        duty_estimate: dutyEstimate,
        summary: {
            candidate_count: fused.length,
            best_confidence: bestConfidence,
            best_band: best ? band(bestConfidence) : null,
            needs_review: !best || bestConfidence < REVIEW_THRESHOLD,
            flagged: complianceFlags.length > 0,
            blocking: !!blocking,
        },
    };
}

module.exports = {
    build,
    fuse,
    ENGINE_VERSION,
};
