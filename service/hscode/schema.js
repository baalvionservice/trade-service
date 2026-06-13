'use strict';
/**
 * HS Code Intelligence Engine — VOCABULARY + FACTORIES (Prompt 7).
 *
 * PURE: no DB, no I/O, no network. Defines the single stable vocabulary every
 * layer of the engine speaks — classification METHODs, CONFIDENCE bands,
 * compliance FLAG codes + severity — and the `suggestion()` / `complianceFlag()`
 * factories every producer funnels through so the emitted `hs_suggestion_report`
 * is shape-identical regardless of which layer (search / AI / fallback) raised it.
 *
 * A SUGGESTION is the atomic unit of a classification:
 *   {
 *     hs_code:        canonical 6-digit (or longer national) HS code
 *     description:    human description of the heading/subheading
 *     chapter:        2-digit chapter
 *     heading:        4-digit heading
 *     category:       coarse commodity family (agriculture / electronics / ...)
 *     method:         METHOD.*  — how this candidate was derived
 *     confidence:     0..100    — how sure the engine is THIS code is correct
 *     confidence_band: band(confidence)
 *     matched_on:     [string]  — the signals that produced the match
 *     national_code:  country-specific extension (8/10 digit) when resolved
 *     country:        ISO-2 country the national_code/duty applies to (or null)
 *     source:         'database' | 'ai' | 'fallback'
 *   }
 *
 * A COMPLIANCE FLAG:
 *   {
 *     code:      FLAG.*                  — stable machine code
 *     severity:  SEVERITY.*              — drives review/blocking semantics
 *     hs_code, country, message
 *     requires:  optional permit/licence name the flag mandates
 *     source:    'tariff' | 'chapter' | 'engine'
 *   }
 */

// ── Severity ladder. Order matters: index = rank (higher = worse). ───────────
const SEVERITY = Object.freeze({
    INFO: 'info',
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical',
});

const SEVERITY_ORDER = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

/** Numeric rank for a severity (unknown → -1). Used for sort + worst-of folds. */
function severityRank(severity) {
    return SEVERITY_ORDER.indexOf(severity);
}

// ── How a candidate HS code was derived. ─────────────────────────────────────
const METHOD = Object.freeze({
    EXACT: 'exact',       // caller supplied a code that resolves to a known entry
    SEARCH: 'search',     // keyword/token search over the HS database
    AI: 'ai',             // the pluggable AI suggestion provider
    FALLBACK: 'fallback', // the deterministic fallback rules engine
    MANUAL: 'manual',     // a human-asserted code (persisted classifications)
});

const VALID_SOURCES = Object.freeze(['database', 'ai', 'fallback', 'manual']);

// ── Confidence bands. ────────────────────────────────────────────────────────
const CONFIDENCE_BAND = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });
const BAND_HIGH_MIN = 75;
const BAND_MEDIUM_MIN = 50;

// Below this, the best suggestion is treated as needing human review.
const REVIEW_THRESHOLD = 50;

// The fallback rules engine is a coarse chapter-level heuristic — its candidates
// are capped so they never out-rank a real search/AI hit.
const FALLBACK_CONFIDENCE_CAP = 55;

/** Map a 0..100 confidence to its band. */
function band(confidence) {
    const c = clampConfidence(confidence);
    if (c >= BAND_HIGH_MIN) return CONFIDENCE_BAND.HIGH;
    if (c >= BAND_MEDIUM_MIN) return CONFIDENCE_BAND.MEDIUM;
    return CONFIDENCE_BAND.LOW;
}

// ── Compliance flag codes. ───────────────────────────────────────────────────
const FLAG = Object.freeze({
    PROHIBITED: 'PROHIBITED',                       // import/export not permitted
    LICENSE_REQUIRED: 'LICENSE_REQUIRED',           // import/export licence needed
    EXPORT_CONTROLLED: 'EXPORT_CONTROLLED',         // strategic/export-control list
    DUAL_USE: 'DUAL_USE',                           // dual-use (civil + military)
    IMPORT_RESTRICTED: 'IMPORT_RESTRICTED',         // restricted, conditions apply
    PERMIT_REQUIRED: 'PERMIT_REQUIRED',             // sanitary/phyto/other permit
    INSPECTION_REQUIRED: 'INSPECTION_REQUIRED',     // mandatory inspection
    SANCTIONS_SENSITIVE: 'SANCTIONS_SENSITIVE',     // sanctions screening advised
    EXCISE_GOODS: 'EXCISE_GOODS',                   // excise duty applies
    NO_TARIFF_LINE: 'NO_TARIFF_LINE',               // no national line for country
    LOW_CONFIDENCE_CLASSIFICATION: 'LOW_CONFIDENCE_CLASSIFICATION',
    UNCLASSIFIED_PRODUCT: 'UNCLASSIFIED_PRODUCT',   // nothing matched at all
});

const clampConfidence = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
};

/**
 * Build a normalized suggestion — the single choke-point every producer uses.
 * @returns {object} a frozen suggestion
 */
function suggestion(s = {}) {
    const {
        hs_code,
        description = null,
        chapter = null,
        heading = null,
        category = null,
        method = METHOD.SEARCH,
        confidence = 0,
        matched_on = [],
        national_code = null,
        country = null,
        source = 'database',
    } = s;

    if (!hs_code) throw new Error('suggestion(): `hs_code` is required');
    if (!Object.values(METHOD).includes(method)) {
        throw new Error(`suggestion(): unknown method '${method}'`);
    }
    if (!VALID_SOURCES.includes(source)) {
        throw new Error(`suggestion(): unknown source '${source}'`);
    }

    const conf = clampConfidence(confidence);
    return Object.freeze({
        hs_code: String(hs_code),
        description,
        chapter,
        heading,
        category,
        method,
        confidence: conf,
        confidence_band: band(conf),
        matched_on: Object.freeze([...matched_on]),
        national_code,
        country,
        source,
    });
}

/**
 * Build a normalized compliance flag.
 * @returns {object} a frozen compliance flag
 */
function complianceFlag(f = {}) {
    const {
        code,
        severity = SEVERITY.MEDIUM,
        hs_code = null,
        country = null,
        message = '',
        requires = null,
        source = 'engine',
    } = f;

    if (!code) throw new Error('complianceFlag(): `code` is required');
    if (!SEVERITY_ORDER.includes(severity)) {
        throw new Error(`complianceFlag(): unknown severity '${severity}'`);
    }

    return Object.freeze({
        code,
        severity,
        hs_code: hs_code ? String(hs_code) : null,
        country: country || null,
        message,
        requires: requires || null,
        source,
    });
}

module.exports = {
    SEVERITY,
    SEVERITY_ORDER,
    severityRank,
    METHOD,
    VALID_SOURCES,
    CONFIDENCE_BAND,
    BAND_HIGH_MIN,
    BAND_MEDIUM_MIN,
    REVIEW_THRESHOLD,
    FALLBACK_CONFIDENCE_CAP,
    band,
    FLAG,
    clampConfidence,
    suggestion,
    complianceFlag,
};
