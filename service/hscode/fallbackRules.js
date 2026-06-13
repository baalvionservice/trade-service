'use strict';
/**
 * HS Code Intelligence Engine — FALLBACK RULES ENGINE (Prompt 7).
 *
 * PURE: no DB, no network. When keyword search and the AI layer fail to produce
 * a confident match, this deterministic rules engine maps coarse product signals
 * (material, broad category, generic nouns) to a CHAPTER/HEADING and emits a
 * low-confidence candidate so the engine always returns *something actionable*
 * with an explicit "needs review" posture rather than an empty result.
 *
 * A RULE is { name, test(tokens, text) → bool, code, severity?, reason }.
 * `code` is a representative HS subheading present in the canonical database;
 * the candidate it produces is confidence-capped (schema.FALLBACK_CONFIDENCE_CAP)
 * so a fallback guess can never out-rank a genuine search/AI hit.
 *
 * Rules are evaluated in order; ALL matching rules contribute a candidate (so an
 * ambiguous "steel electronic part" surfaces both metal and electronics chapters
 * for a human to disambiguate), de-duplicated by code.
 */

const db = require('./hsDatabase');
const norm = require('./normalize');
const { suggestion, METHOD, FALLBACK_CONFIDENCE_CAP, clampConfidence } = require('./schema');

const has = (tokens, ...words) => words.some((w) => tokens.has(w));

// Ordered coarse rules. `code` MUST exist in hsDatabase (asserted at load).
const RULES = [
    { name: 'firearms', test: (t) => has(t, 'gun', 'firearm', 'pistol', 'revolver', 'weapon', 'rifle', 'ammunition'), code: '930200', base: 50, reason: 'Weapon/firearm signal → Chapter 93 (arms & ammunition)' },
    { name: 'pharma', test: (t) => has(t, 'medicine', 'drug', 'pharmaceutical', 'medicament', 'tablet', 'capsule', 'vaccine'), code: '300490', base: 48, reason: 'Pharmaceutical signal → Chapter 30 (pharmaceutical products)' },
    { name: 'electronics', test: (t) => has(t, 'electronic', 'electronics', 'circuit', 'device', 'gadget', 'appliance', 'computer'), code: '847130', base: 40, reason: 'Electronic-goods signal → Chapters 84/85 (machinery & electronics)' },
    { name: 'vehicle', test: (t) => has(t, 'vehicle', 'car', 'automobile', 'automotive', 'motor'), code: '870323', base: 42, reason: 'Vehicle signal → Chapter 87 (vehicles)' },
    { name: 'apparel', test: (t) => has(t, 'apparel', 'garment', 'clothing', 'wear', 'shirt', 'textile', 'fabric'), code: '610910', base: 40, reason: 'Apparel/textile signal → Chapters 61/62 (clothing)' },
    { name: 'footwear', test: (t) => has(t, 'shoe', 'shoes', 'footwear', 'sneaker', 'boot', 'sandal'), code: '640299', base: 44, reason: 'Footwear signal → Chapter 64 (footwear)' },
    { name: 'steel', test: (t) => has(t, 'steel', 'iron', 'ferrous'), code: '720851', base: 42, reason: 'Ferrous-metal signal → Chapter 72 (iron & steel)' },
    { name: 'copper', test: (t) => has(t, 'copper'), code: '740311', base: 46, reason: 'Copper signal → Chapter 74 (copper)' },
    { name: 'aluminium', test: (t) => has(t, 'aluminium', 'aluminum'), code: '760110', base: 46, reason: 'Aluminium signal → Chapter 76 (aluminium)' },
    { name: 'plastic', test: (t) => has(t, 'plastic', 'plastics', 'polymer', 'pvc', 'polyethylene'), code: '392690', base: 40, reason: 'Plastics signal → Chapter 39 (plastics)' },
    { name: 'chemical', test: (t) => has(t, 'chemical', 'reagent', 'solvent', 'acid', 'compound'), code: '290511', base: 35, reason: 'Chemical signal → Chapters 28/29 (chemicals)' },
    { name: 'machinery', test: (t) => has(t, 'machine', 'machinery', 'engine', 'pump', 'motor', 'equipment'), code: '840734', base: 38, reason: 'Machinery signal → Chapter 84 (machinery)' },
    { name: 'food', test: (t) => has(t, 'food', 'edible', 'grain', 'cereal', 'fruit', 'vegetable', 'rice', 'wheat'), code: '100630', base: 36, reason: 'Foodstuff signal → Chapters 01–24 (agriculture & food)' },
    { name: 'wood', test: (t) => has(t, 'wood', 'timber', 'lumber', 'plywood'), code: '440710', base: 42, reason: 'Wood signal → Chapter 44 (wood)' },
    { name: 'toy', test: (t) => has(t, 'toy', 'toys', 'doll', 'puzzle', 'game'), code: '950300', base: 44, reason: 'Toy/game signal → Chapter 95 (toys & games)' },
    { name: 'jewellery', test: (t) => has(t, 'jewellery', 'jewelry', 'gold', 'silver', 'ornament', 'gemstone'), code: '711319', base: 42, reason: 'Precious-goods signal → Chapter 71 (jewellery & precious metals)' },
];

// Assert every rule points at a real entry, fail-fast at module load.
for (const r of RULES) {
    if (!db.findByCode(r.code)) {
        throw new Error(`fallbackRules: rule '${r.name}' references unknown HS code '${r.code}'`);
    }
}

/**
 * Produce fallback candidates for a product description.
 * @param {object} input
 * @param {string} input.product
 * @param {string} [input.country]
 * @param {number} [input.limit=3]
 * @returns {object[]} suggestion()s (method: fallback), confidence-capped
 */
function run({ product = '', country = null, limit = 3 } = {}) {
    const tokens = new Set(norm.tokenize(product));
    const text = norm.cleanText(product);
    if (tokens.size === 0) return [];

    const iso = norm.normalizeCountry(country);
    const seen = new Set();
    const out = [];

    for (const rule of RULES) {
        if (out.length >= limit) break;
        let matched = false;
        try {
            matched = rule.test(tokens, text);
        } catch {
            matched = false;
        }
        if (!matched || seen.has(rule.code)) continue;
        seen.add(rule.code);

        const entry = db.findByCode(rule.code);
        const line = iso ? db.tariffLine(entry, iso) : null;
        out.push(suggestion({
            hs_code: entry.hs_code,
            description: entry.description,
            chapter: entry.chapter,
            heading: entry.heading,
            category: entry.category,
            method: METHOD.FALLBACK,
            confidence: clampConfidence(Math.min(rule.base, FALLBACK_CONFIDENCE_CAP)),
            matched_on: [`fallback:${rule.name}`, rule.reason],
            national_code: line ? line.national : null,
            country: line ? iso : null,
            source: 'fallback',
        }));
    }
    return out;
}

module.exports = { run, RULES };
