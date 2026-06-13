'use strict';
/**
 * AI Document Validation Engine — value NORMALIZERS (Prompt 5).
 *
 * PURE: no DB, no I/O. Trade documents are produced by many parties in many
 * formats; before two values can be compared they must be reduced to a single
 * canonical form. Comparing "1,000.00 USD" against "$1000" or "1 tonne" against
 * "1000 kg" only works once both sides pass through here.
 *
 * Every normalizer returns `null` when the input cannot be understood, so the
 * caller can distinguish "absent / unparseable" from "present but mismatched".
 */

// ── Numbers ──────────────────────────────────────────────────────────────────
// Accepts 1234.5, "1,234.50", "$1 234,50" (eu), "1.234,50". Heuristic but safe:
// the last separator group is treated as the decimal when ambiguous.
function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;

    let s = value.trim().replace(/[^\d.,\-]/g, '');
    if (s === '' || s === '-' || s === '.' || s === ',') return null;

    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    if (hasComma && hasDot) {
        // Whichever separator appears LAST is the decimal separator.
        if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
            s = s.replace(/\./g, '').replace(',', '.'); // EU: 1.234,50
        } else {
            s = s.replace(/,/g, ''); // US: 1,234.50
        }
    } else if (hasComma) {
        // Comma only: decimal if it looks like ",dd", else a thousands sep.
        s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

// ── Currency ─────────────────────────────────────────────────────────────────
const SYMBOL_TO_ISO = Object.freeze({
    $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW',
    '₽': 'RUB', '₺': 'TRY', '₴': 'UAH', '₦': 'NGN', '₫': 'VND', '฿': 'THB',
});
// Common ambiguous textual aliases → ISO 4217.
const ALIAS_TO_ISO = Object.freeze({
    US$: 'USD', USDOLLAR: 'USD', DOLLAR: 'USD', DOLLARS: 'USD', EURO: 'EUR',
    EUROS: 'EUR', POUND: 'GBP', POUNDS: 'GBP', STERLING: 'GBP', YEN: 'JPY',
    RUPEE: 'INR', RUPEES: 'INR', RMB: 'CNY', YUAN: 'CNY', DIRHAM: 'AED',
    DIRHAMS: 'AED', RIYAL: 'SAR', SGDOLLAR: 'SGD',
});

function toCurrency(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (raw === '') return null;
    if (SYMBOL_TO_ISO[raw]) return SYMBOL_TO_ISO[raw];

    const upper = raw.toUpperCase().replace(/[^A-Z$€£¥₹₩₽₺₴₦₫฿]/g, '');
    if (SYMBOL_TO_ISO[upper]) return SYMBOL_TO_ISO[upper];
    if (ALIAS_TO_ISO[upper]) return ALIAS_TO_ISO[upper];
    // A clean 3-letter ISO code.
    if (/^[A-Z]{3}$/.test(upper)) return upper;
    // Leading symbol on a "$1000"-style token.
    const sym = raw[0];
    if (SYMBOL_TO_ISO[sym]) return SYMBOL_TO_ISO[sym];
    return null;
}

// ── Weight → grams (canonical base unit) ─────────────────────────────────────
const WEIGHT_TO_GRAMS = Object.freeze({
    g: 1, gram: 1, grams: 1, gm: 1, gms: 1,
    kg: 1000, kgs: 1000, kilogram: 1000, kilograms: 1000, kilo: 1000, kilos: 1000,
    t: 1_000_000, mt: 1_000_000, ton: 1_000_000, tons: 1_000_000, tonne: 1_000_000,
    tonnes: 1_000_000, metricton: 1_000_000, metrictons: 1_000_000,
    lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
    oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
});

/**
 * Normalize a weight to grams.
 * @param {number|string|{value,unit}} value
 * @param {string} [defaultUnit='kg'] unit assumed when a bare number is given.
 * @returns {number|null} grams, or null if unparseable.
 */
function toGrams(value, defaultUnit = 'kg') {
    if (value === null || value === undefined || value === '') return null;

    let amount = null;
    let unit = defaultUnit;

    if (typeof value === 'object') {
        amount = toNumber(value.value ?? value.amount ?? value.weight);
        unit = value.unit || value.uom || defaultUnit;
    } else if (typeof value === 'number') {
        amount = value;
    } else {
        const str = String(value).trim();
        amount = toNumber(str);
        const m = str.match(/([a-zA-Z]+)\s*$/);
        if (m) unit = m[1];
    }
    if (amount === null) return null;

    const key = String(unit).toLowerCase().replace(/[^a-z]/g, '');
    const factor = WEIGHT_TO_GRAMS[key];
    if (factor === undefined) return null;
    return amount * factor;
}

// ── Address normalization + similarity ───────────────────────────────────────
// Expand the abbreviations that most often cause false mismatches.
const ADDRESS_ABBREV = Object.freeze({
    st: 'street', str: 'street', rd: 'road', ave: 'avenue', av: 'avenue',
    blvd: 'boulevard', ln: 'lane', dr: 'drive', ct: 'court', sq: 'square',
    hwy: 'highway', apt: 'apartment', ste: 'suite', bldg: 'building',
    fl: 'floor', n: 'north', s: 'south', e: 'east', w: 'west',
    pkwy: 'parkway', co: 'company', corp: 'corporation', ltd: 'limited',
    inc: 'incorporated',
});

/** Reduce an address (string or structured object) to a sorted token set. */
function addressTokens(value) {
    if (value === null || value === undefined) return [];
    let str;
    if (typeof value === 'object') {
        str = [
            value.line1, value.line2, value.street, value.city, value.state,
            value.region, value.postal_code, value.postalCode, value.zip,
            value.country,
        ].filter(Boolean).join(' ');
    } else {
        str = String(value);
    }
    const tokens = str
        .toLowerCase()
        .replace(/[.,#/\\\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean)
        .map((tok) => ADDRESS_ABBREV[tok] || tok);
    return Array.from(new Set(tokens)).sort();
}

/**
 * Jaccard similarity (0..1) between two address token sets. 1 = identical token
 * vocabulary, 0 = nothing in common.
 */
function addressSimilarity(a, b) {
    const ta = addressTokens(a);
    const tb = addressTokens(b);
    if (ta.length === 0 && tb.length === 0) return 1;
    if (ta.length === 0 || tb.length === 0) return 0;
    const setB = new Set(tb);
    let intersection = 0;
    for (const tok of ta) if (setB.has(tok)) intersection += 1;
    const union = ta.length + tb.length - intersection;
    return union === 0 ? 1 : intersection / union;
}

/** True when a value is meaningfully absent (null/undefined/blank/empty). */
function isBlank(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

module.exports = {
    toNumber,
    toCurrency,
    toGrams,
    addressTokens,
    addressSimilarity,
    isBlank,
    WEIGHT_TO_GRAMS,
};
