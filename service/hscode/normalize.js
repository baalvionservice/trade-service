'use strict';
/**
 * HS Code Intelligence Engine — NORMALIZERS (Prompt 7).
 *
 * PURE: no DB, no I/O. Two jobs:
 *   1. Normalize HS codes themselves — strip the human punctuation (dots, spaces),
 *      keep only digits, and expose the 2/4/6-digit prefixes that the World
 *      Customs Organization Harmonized System is structured around:
 *        chapter (2) → heading (4) → subheading (6) → national (8/10).
 *   2. Normalize free-text PRODUCT descriptions into a comparable token bag so
 *      the search + fallback layers can score keyword overlap deterministically.
 */

// Common English stopwords + trade-noise tokens that carry no classification
// signal. Kept small and intentional — over-stemming hurts precision.
const STOPWORDS = new Set([
    'a', 'an', 'the', 'of', 'for', 'and', 'or', 'with', 'without', 'to', 'in',
    'on', 'by', 'from', 'as', 'at', 'is', 'are', 'be', 'this', 'that', 'these',
    'new', 'used', 'other', 'pcs', 'pieces', 'piece', 'unit', 'units', 'item',
    'items', 'product', 'products', 'goods', 'good', 'misc', 'assorted', 'set',
]);

/** Keep digits only — drops the conventional dots/spaces in "0901.11" etc. */
function digitsOnly(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[^0-9]/g, '');
}

/**
 * Normalize an HS code to its canonical digit string and structural prefixes.
 * Returns null when there are not enough digits to be a valid HS reference
 * (the HS subheading level is 6 digits).
 *
 * @param {string|number} value
 * @returns {{ code:string, chapter:string, heading:string, subheading:string,
 *             national:string|null, length:number } | null}
 */
function normalizeHsCode(value) {
    const digits = digitsOnly(value);
    if (digits.length < 2) return null;
    // HS subheading is 6 digits; national extensions go to 8 or 10. Anything
    // longer than 10 is malformed — clamp defensively rather than reject so a
    // sloppy national code still resolves to its 6-digit parent.
    const code = digits.slice(0, 10);
    return {
        code,
        chapter: code.slice(0, 2),
        heading: code.length >= 4 ? code.slice(0, 4) : code,
        subheading: code.length >= 6 ? code.slice(0, 6) : code,
        national: code.length > 6 ? code : null,
        length: code.length,
    };
}

/** True when `value` looks like a usable HS code (≥ 6 digits → subheading). */
function isHsCodeLike(value) {
    return digitsOnly(value).length >= 6;
}

/** Lowercase, strip punctuation, collapse whitespace. */
function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9%/+\-\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Tokenize a product description into a deduplicated, stopword-stripped bag of
 * meaningful tokens (length ≥ 2). The unit the search/fallback layers compare.
 *
 * @param {string} value
 * @returns {string[]}
 */
function tokenize(value) {
    const cleaned = cleanText(value);
    if (!cleaned) return [];
    const out = [];
    const seen = new Set();
    for (const raw of cleaned.split(' ')) {
        const tok = raw.trim();
        if (tok.length < 2) continue;
        if (STOPWORDS.has(tok)) continue;
        if (seen.has(tok)) continue;
        seen.add(tok);
        out.push(tok);
    }
    return out;
}

/** Jaccard overlap of two token bags (1 when both empty). */
function tokenOverlap(a, b) {
    const ta = new Set(a);
    const tb = new Set(b);
    if (ta.size === 0 && tb.size === 0) return 1;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection += 1;
    const union = ta.size + tb.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/** Normalize a country to ISO-3166-1 alpha-2 upper (best-effort, null if blank). */
function normalizeCountry(value) {
    if (value === null || value === undefined) return null;
    const v = String(value).trim().toUpperCase();
    if (!v) return null;
    return ALPHA3_TO_ALPHA2[v] || v.slice(0, 2);
}

// A handful of common alpha-3 inputs mapped to alpha-2; everything else is
// truncated to its first two chars (already-alpha-2 inputs pass through).
const ALPHA3_TO_ALPHA2 = Object.freeze({
    USA: 'US', GBR: 'GB', IND: 'IN', ARE: 'AE', SGP: 'SG',
    CHN: 'CN', DEU: 'DE', FRA: 'FR', JPN: 'JP', AUS: 'AU',
});

/** True when a value is meaningfully absent. */
function isBlank(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

module.exports = {
    digitsOnly,
    normalizeHsCode,
    isHsCodeLike,
    cleanText,
    tokenize,
    tokenOverlap,
    normalizeCountry,
    isBlank,
    STOPWORDS,
};
