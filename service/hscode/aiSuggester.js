'use strict';
/**
 * HS Code Intelligence Engine — pluggable AI SUGGESTION ENGINE (Prompt 7).
 *
 * The AI layer answers "given this product, which HS subheadings are most
 * likely?" with reasoning a flat keyword search can't fully capture. It is
 * PLUGGABLE by design (mirrors validation/aiClassifier): the default provider is
 * a deterministic, network-free HEURISTIC that wraps the search layer and applies
 * light domain inference, so the engine works offline and tests are reproducible.
 * A real model — Claude, a fine-tuned tariff classifier, a vendor classification
 * API — is dropped in with `registerProvider()` without touching the engine,
 * search, fallback, or report code.
 *
 * A provider MUST implement:
 *   {
 *     name: string,
 *     async suggest({ product, country, context, limit }) => {
 *       suggestions: suggestion[]   // schema.suggestion(... method:'ai')
 *       reasoning?:  string         // optional human-readable rationale
 *     }
 *   }
 *
 * The engine always normalizes/clamps a provider's output so a misbehaving
 * plug-in can never crash classification — at worst it degrades to empty.
 */

const search = require('./search');
const db = require('./hsDatabase');
const norm = require('./normalize');
const { suggestion, METHOD, clampConfidence } = require('./schema');

// Light material/attribute hints the heuristic uses to nudge confidence when the
// product text corroborates an entry's category. Coarse on purpose.
const CATEGORY_HINTS = Object.freeze({
    electronics: ['electronic', 'digital', 'device', 'smart', 'wireless', 'battery'],
    textiles: ['cotton', 'fabric', 'woven', 'knitted', 'yarn', 'wear', 'apparel'],
    pharmaceuticals: ['dose', 'mg', 'medical', 'pharma', 'therapeutic', 'capsule'],
    chemicals: ['chemical', 'industrial grade', 'reagent', 'compound', 'grade'],
    metals: ['metal', 'alloy', 'ingot', 'cathode', 'rolled', 'sheet'],
    vehicles: ['vehicle', 'automotive', 'motor', 'car', 'engine'],
});

function categoryCorroboration(product, category) {
    const hints = CATEGORY_HINTS[category];
    if (!hints) return 0;
    const text = norm.cleanText(product);
    let hits = 0;
    for (const h of hints) if (text.includes(h)) hits += 1;
    return hits;
}

/**
 * The default, deterministic heuristic provider. Wraps search, re-stamps the
 * method as `ai`, and applies a small category-corroboration adjustment.
 */
const heuristicProvider = Object.freeze({
    name: 'heuristic',
    async suggest({ product = '', country = null, limit = 5 } = {}) {
        const base = search.search({ query: product, country, limit: Math.max(limit, 5) });
        const suggestions = base.map((s) => {
            const corroboration = categoryCorroboration(product, s.category);
            // Each corroborating hint adds up to a few points, capped — the AI
            // layer "agrees harder" when the description's attributes fit.
            const adjusted = clampConfidence(s.confidence + Math.min(corroboration * 3, 9));
            return suggestion({
                hs_code: s.hs_code,
                description: s.description,
                chapter: s.chapter,
                heading: s.heading,
                category: s.category,
                method: METHOD.AI,
                confidence: adjusted,
                matched_on: corroboration > 0
                    ? [...s.matched_on, `ai_category_corroboration:${corroboration}`].slice(0, 9)
                    : s.matched_on,
                national_code: s.national_code,
                country: s.country,
                source: 'ai',
            });
        }).slice(0, limit);
        return {
            suggestions,
            reasoning: suggestions.length
                ? `Heuristic AI matched product against ${db.all().length} HS subheadings; top candidate '${suggestions[0].hs_code}' at ${suggestions[0].confidence}% confidence.`
                : 'Heuristic AI found no plausible HS subheading for the product description.',
        };
    },
});

// ── Provider registry (the pluggable / mockable seam). ───────────────────────
let activeProvider = heuristicProvider;

function assertProvider(p) {
    if (!p || typeof p.suggest !== 'function' || typeof p.name !== 'string') {
        throw new Error('registerProvider(): provider must be { name: string, suggest: async fn }');
    }
}

/** Swap in a different suggestion provider (e.g. an LLM-backed one). */
function registerProvider(provider) {
    assertProvider(provider);
    activeProvider = provider;
    return activeProvider;
}

/** Reset to the built-in deterministic heuristic provider. */
function resetProvider() {
    activeProvider = heuristicProvider;
    return activeProvider;
}

function getProvider() {
    return activeProvider;
}

/** Coerce any provider suggestion-ish object into a normalized suggestion(). */
function coerce(s, country) {
    if (!s || !s.hs_code) return null;
    const entry = db.findByCode(s.hs_code);
    const iso = norm.normalizeCountry(s.country || country);
    const line = entry && iso ? db.tariffLine(entry, iso) : null;
    return suggestion({
        hs_code: entry ? entry.hs_code : s.hs_code,
        description: s.description || (entry && entry.description) || null,
        chapter: s.chapter || (entry && entry.chapter) || null,
        heading: s.heading || (entry && entry.heading) || null,
        category: s.category || (entry && entry.category) || null,
        method: METHOD.AI,
        confidence: s.confidence,
        matched_on: Array.isArray(s.matched_on) ? s.matched_on : [],
        national_code: s.national_code || (line ? line.national : null),
        country: line ? iso : (s.country || null),
        source: 'ai',
    });
}

/**
 * Suggest HS codes with the active provider, defensively normalizing the result.
 * @returns {{ suggestions: object[], reasoning: string|null, provider: string, degraded: boolean }}
 */
async function suggest(input = {}) {
    let result;
    try {
        result = await activeProvider.suggest(input || {});
    } catch (err) {
        return {
            suggestions: [],
            reasoning: `AI suggestion provider '${activeProvider.name}' failed: ${err.message}`,
            provider: activeProvider.name,
            degraded: true,
        };
    }
    const raw = Array.isArray(result && result.suggestions) ? result.suggestions : [];
    const suggestions = raw.map((s) => coerce(s, input.country)).filter(Boolean);
    return {
        suggestions,
        reasoning: (result && result.reasoning) || null,
        provider: activeProvider.name,
        degraded: false,
    };
}

module.exports = {
    suggest,
    registerProvider,
    resetProvider,
    getProvider,
    heuristicProvider,
    CATEGORY_HINTS,
};
