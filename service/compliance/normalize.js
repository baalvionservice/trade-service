'use strict';
/**
 * Compliance & Sanctions Engine — NORMALIZERS + matchers (War Room 4, Prompt 8).
 *
 * PURE: no DB, no I/O. Turns the messy, free-text inputs a screening receives
 * (country names, party names, goods descriptions, HS codes) into the canonical
 * comparable forms the rules engine matches on. Matching compliance subjects is
 * adversarial — a sanctioned party will spell its name differently every time —
 * so the matchers here are deliberately fuzzy-but-bounded: normalized exact,
 * alias-aware, and token/substring containment, never a raw `===` on raw input.
 */

// A compact ISO-3166 alpha-3 → alpha-2 map plus the most common country-NAME →
// alpha-2 synonyms the engine sees in trade documents. Intentionally small and
// curated — the dataset stores alpha-2, so we only need to funnel inputs to it.
const COUNTRY_SYNONYMS = Object.freeze({
    // alpha-3
    USA: 'US', GBR: 'GB', IND: 'IN', ARE: 'AE', SGP: 'SG', CHN: 'CN', DEU: 'DE',
    FRA: 'FR', JPN: 'JP', AUS: 'AU', RUS: 'RU', IRN: 'IR', PRK: 'KP', SYR: 'SY',
    CUB: 'CU', VEN: 'VE', BLR: 'BY', MMR: 'MM',
    // names / synonyms
    'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', AMERICA: 'US',
    'UNITED KINGDOM': 'GB', BRITAIN: 'GB', ENGLAND: 'GB',
    'UNITED ARAB EMIRATES': 'AE', EMIRATES: 'AE',
    RUSSIA: 'RU', 'RUSSIAN FEDERATION': 'RU',
    IRAN: 'IR', 'ISLAMIC REPUBLIC OF IRAN': 'IR',
    'NORTH KOREA': 'KP', DPRK: 'KP', "DEMOCRATIC PEOPLE'S REPUBLIC OF KOREA": 'KP',
    SYRIA: 'SY', CUBA: 'CU', VENEZUELA: 'VE', BELARUS: 'BY',
    MYANMAR: 'MM', BURMA: 'MM', CHINA: 'CN', INDIA: 'IN', SINGAPORE: 'SG',
});

/**
 * Normalize a country input to ISO-3166-1 alpha-2 upper. Resolves common alpha-3
 * codes and English country names; an already-alpha-2 input passes through.
 * Returns null when blank.
 *
 * @param {string} value
 * @returns {string|null}
 */
function normalizeCountry(value) {
    if (value === null || value === undefined) return null;
    const v = String(value).trim().toUpperCase();
    if (!v) return null;
    if (COUNTRY_SYNONYMS[v]) return COUNTRY_SYNONYMS[v];
    if (v.length === 2) return v;
    // Unknown 3+ char token: do NOT truncate to two letters. Truncating "IRQ"
    // (Iraq) → "IR" (Iran) would manufacture a false-positive sanctions hit. Every
    // sanctioned jurisdiction is covered by COUNTRY_SYNONYMS (alpha-3 + names), so
    // an unresolved token is treated as "not a known country" (returns null) rather
    // than guessed — fail safe against mis-attribution, not against under-screening.
    return null;
}

/** Keep digits only from an HS code (drops the conventional dots/spaces). */
function digitsOnly(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[^0-9]/g, '');
}

/**
 * Normalize a party / entity name for comparison: uppercase, strip legal-form
 * suffixes and punctuation, collapse whitespace. "Acme Trading Co., Ltd." and
 * "ACME TRADING" both reduce toward the same comparable core.
 */
function normalizeName(value) {
    if (value === null || value === undefined) return '';
    let s = String(value).toUpperCase();
    s = s.replace(/[^A-Z0-9\s]/g, ' '); // drop punctuation
    s = s.replace(/\b(CO|LTD|LLC|INC|CORP|GMBH|PLC|LLP|PTE|PVT|SA|AG|BV|JSC|OOO|FZE|FZCO)\b/g, ' ');
    s = s.replace(/\b(LIMITED|COMPANY|CORPORATION|INCORPORATED|TRADING|GROUP|HOLDINGS?)\b/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
}

// Minimum normalized-core length for a CONTAINMENT (substring) party-name match.
// Shorter cores must match exactly — guards against broad false positives.
const MIN_CONTAINMENT_CORE = 4;

/** Lowercase free text, strip punctuation, collapse whitespace. */
function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9%/+\-\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Tokenize free text into a deduplicated bag of meaningful tokens (length ≥ 2). */
function tokenize(value) {
    const cleaned = cleanText(value);
    if (!cleaned) return [];
    const out = [];
    const seen = new Set();
    for (const raw of cleaned.split(' ')) {
        const tok = raw.trim();
        if (tok.length < 2) continue;
        if (seen.has(tok)) continue;
        seen.add(tok);
        out.push(tok);
    }
    return out;
}

/**
 * True when a candidate name matches a target name or any of its aliases.
 * Match is on the normalized core: exact-equal OR one fully contains the other
 * (so "ACME" matches "ACME TRADING" and vice-versa). A bare empty core never
 * matches — guards against a stripped-to-nothing input matching everything.
 *
 * @param {string} candidate     the name being screened
 * @param {string} target        the canonical sanctioned name
 * @param {string[]} [aliases=[]] known aliases of the target
 */
function nameMatches(candidate, target, aliases = []) {
    const c = normalizeName(candidate);
    if (!c) return false;
    const targets = [target, ...(Array.isArray(aliases) ? aliases : [])]
        .map(normalizeName)
        .filter(Boolean);
    for (const t of targets) {
        if (c === t) return true;
        // Containment, but (a) whole-word boundary via padded spaces to avoid "IRAN"
        // matching "MIRANDA", and (b) the contained (shorter) core must be ≥ MIN_CORE
        // chars so a very short canonical name (e.g. "EAST") can't broad-match every
        // longer party name. Below that length we already required exact equality above.
        const shorter = c.length <= t.length ? c : t;
        if (shorter.length < MIN_CONTAINMENT_CORE) continue;
        const cp = ` ${c} `;
        const tp = ` ${t} `;
        if (cp.includes(tp) || tp.includes(cp)) return true;
    }
    return false;
}

/**
 * True when an HS code falls under any of the given prefixes (chapter/heading/
 * subheading). "851712" matches prefix "8517" and "85". Empty prefix list → false.
 *
 * @param {string} hsCode
 * @param {string[]} prefixes
 */
function hsPrefixMatches(hsCode, prefixes) {
    const code = digitsOnly(hsCode);
    if (!code || !Array.isArray(prefixes) || prefixes.length === 0) return false;
    return prefixes.some((p) => {
        const pref = digitsOnly(p);
        return pref && code.startsWith(pref);
    });
}

/**
 * True when any keyword appears as a whole token in (or as a substring of) the
 * goods description. Keyword match is the fallback when no HS code is supplied.
 *
 * @param {string} description
 * @param {string[]} keywords
 */
function keywordMatches(description, keywords) {
    if (!Array.isArray(keywords) || keywords.length === 0) return false;
    const text = cleanText(description);
    if (!text) return false;
    const padded = ` ${text} `;
    return keywords.some((kw) => {
        const k = cleanText(kw);
        if (!k) return false;
        // Multi-word keyword → substring; single token → word-boundary.
        return k.includes(' ') ? text.includes(k) : padded.includes(` ${k} `);
    });
}

/** True when a value is meaningfully absent. */
function isBlank(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

module.exports = {
    normalizeCountry,
    digitsOnly,
    normalizeName,
    cleanText,
    tokenize,
    nameMatches,
    hsPrefixMatches,
    keywordMatches,
    isBlank,
    COUNTRY_SYNONYMS,
};
