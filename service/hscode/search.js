'use strict';
/**
 * HS Code Intelligence Engine — SEARCH (Prompt 7).
 *
 * PURE: no DB, no network. The keyword/token search at the heart of the search
 * API and the default AI provider. Given a free-text product description (and an
 * optional destination country to resolve the national line), it scores every
 * entry in the canonical HS database and returns ranked `suggestion()`s.
 *
 * ── Scoring + CONFIDENCE ──────────────────────────────────────────────────────
 * Each candidate accrues a raw score from three signal types, then that raw score
 * is mapped to a 0..100 confidence:
 *   • exact keyword phrase hit         strong  (+3.0 each)
 *   • query token ∈ entry keyword set  medium  (+1.5 each)
 *   • query token ∈ entry description  weak    (+0.6 each)
 *   • category-name hit                weak    (+0.8)
 * The winner's confidence also reflects its MARGIN over the runner-up — a clear
 * single match reads as high-confidence; a cluster of near-ties reads as medium,
 * which is exactly the signal the fallback engine and review-gate key off.
 */

const db = require('./hsDatabase');
const norm = require('./normalize');
const { suggestion, METHOD, clampConfidence } = require('./schema');

const PHRASE_WEIGHT = 3.0;
const KEYWORD_TOKEN_WEIGHT = 1.5;
const DESC_TOKEN_WEIGHT = 0.6;
const CATEGORY_WEIGHT = 0.8;

// Raw score that, on its own, saturates confidence toward the ceiling. Tuned so
// one strong phrase hit + a couple of token hits lands in the "high" band.
const SATURATION = 6.0;
const MAX_BASE_CONFIDENCE = 96; // never claim 100 from fuzzy search alone

/** Build the searchable token + phrase corpus for an entry (memoized). */
const corpusCache = new WeakMap();
function corpusFor(entry) {
    let c = corpusCache.get(entry);
    if (c) return c;
    const keywordTokens = new Set();
    for (const kw of entry.keywords) for (const tok of norm.tokenize(kw)) keywordTokens.add(tok);
    const descTokens = new Set(norm.tokenize(entry.description));
    c = {
        phrases: entry.keywords.map((k) => norm.cleanText(k)).filter(Boolean),
        keywordTokens,
        descTokens,
        category: norm.cleanText(entry.category || ''),
    };
    corpusCache.set(entry, c);
    return c;
}

/**
 * Score a single entry against a cleaned query string + its tokens.
 * @returns {{ score:number, matched:string[] }}
 */
function scoreEntry(entry, cleanedQuery, queryTokens) {
    const c = corpusFor(entry);
    let score = 0;
    const matched = [];

    // Strong: whole keyword phrase appears in the query (e.g. "green coffee").
    for (const phrase of c.phrases) {
        if (phrase.length >= 3 && cleanedQuery.includes(phrase)) {
            score += PHRASE_WEIGHT;
            matched.push(`phrase:${phrase}`);
        }
    }
    // Medium/weak: per-token hits against keyword set then description.
    for (const tok of queryTokens) {
        if (c.keywordTokens.has(tok)) {
            score += KEYWORD_TOKEN_WEIGHT;
            matched.push(`keyword:${tok}`);
        } else if (c.descTokens.has(tok)) {
            score += DESC_TOKEN_WEIGHT;
            matched.push(`desc:${tok}`);
        }
    }
    // Weak: the query names the commodity category.
    if (c.category && cleanedQuery.includes(c.category)) {
        score += CATEGORY_WEIGHT;
        matched.push(`category:${c.category}`);
    }
    return { score, matched };
}

/** Map a raw score to a base confidence (pre-margin), 0..MAX_BASE_CONFIDENCE. */
function scoreToConfidence(score) {
    if (score <= 0) return 0;
    const ratio = Math.min(1, score / SATURATION);
    return clampConfidence(ratio * MAX_BASE_CONFIDENCE);
}

/**
 * Search the HS database for a product description.
 *
 * @param {object} input
 * @param {string} input.query             free-text product description
 * @param {string} [input.country]         ISO-2 to resolve the national line
 * @param {number} [input.limit=5]         max suggestions returned
 * @param {number} [input.minScore=0.6]    drop candidates below this raw score
 * @returns {object[]} ranked suggestion()s (method: search)
 */
function search({ query, country = null, limit = 5, minScore = 0.6 } = {}) {
    const cleaned = norm.cleanText(query);
    const tokens = norm.tokenize(query);
    if (!cleaned || tokens.length === 0) return [];

    const iso = norm.normalizeCountry(country);

    const scored = [];
    for (const entry of db.all()) {
        const { score, matched } = scoreEntry(entry, cleaned, tokens);
        if (score >= minScore) scored.push({ entry, score, matched });
    }
    if (scored.length === 0) return [];

    scored.sort((a, b) => b.score - a.score);

    const top = scored[0].score;
    const runnerUp = scored[1] ? scored[1].score : 0;
    // Margin in [0,1]: how dominant the winner is over #2. Boosts a clear winner.
    const margin = top > 0 ? (top - runnerUp) / top : 0;

    const out = [];
    for (let i = 0; i < Math.min(limit, scored.length); i += 1) {
        const { entry, score, matched } = scored[i];
        let confidence = scoreToConfidence(score);
        if (i === 0) {
            // Reward a dominant winner; never exceed the fuzzy-search ceiling.
            confidence = clampConfidence(confidence + margin * (MAX_BASE_CONFIDENCE - confidence) * 0.6);
        }
        const line = iso ? db.tariffLine(entry, iso) : null;
        out.push(suggestion({
            hs_code: entry.hs_code,
            description: entry.description,
            chapter: entry.chapter,
            heading: entry.heading,
            category: entry.category,
            method: METHOD.SEARCH,
            confidence,
            matched_on: matched.slice(0, 8),
            national_code: line ? line.national : null,
            country: line ? iso : null,
            source: 'database',
        }));
    }
    return out;
}

module.exports = {
    search,
    scoreEntry,
    scoreToConfidence,
    PHRASE_WEIGHT,
    KEYWORD_TOKEN_WEIGHT,
    DESC_TOKEN_WEIGHT,
};
