'use strict';
/**
 * AI Document Validation Engine — ERROR REPORTING SCHEMA (Prompt 5).
 *
 * This module is PURE: no DB, no I/O, no network. It defines the single, stable
 * vocabulary every validation finding speaks — severity, category, codes — and a
 * `finding()` factory that every check (rules engine + AI layer) funnels through
 * so the emitted `validation_report` is uniform regardless of which layer raised
 * the issue.
 *
 * A FINDING is the atomic unit of the report:
 *   {
 *     code:       stable machine code (CODE.*)           — switchable by consumers
 *     category:   problem family (CATEGORY.*)            — quantity / weight / ...
 *     severity:   SEVERITY.*                              — drives status + readiness
 *     field:      the document field at fault             — e.g. "quantity"
 *     expected:   the canonical/reference value           — from trade op / sibling doc
 *     actual:     the value found on the document         — from extraction
 *     delta:      optional numeric/relative difference
 *     unit:       optional unit for numeric fields
 *     confidence: 0–100, how sure the engine is THIS finding is real
 *     source:     'rules' | 'ai'                          — which layer raised it
 *     message:    human-readable explanation
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

// Readiness penalty each finding of a given severity subtracts from a perfect
// (100) document-validation readiness score. CRITICAL zeroes it outright.
const SEVERITY_PENALTY = Object.freeze({
    info: 0,
    low: 5,
    medium: 15,
    high: 40,
    critical: 100,
});

// ── Problem families. ────────────────────────────────────────────────────────
const CATEGORY = Object.freeze({
    QUANTITY: 'quantity',
    WEIGHT: 'weight',
    ADDRESS: 'address',
    CURRENCY: 'currency',
    TAX: 'tax',
    COMPLETENESS: 'completeness',
    CLASSIFICATION: 'classification',
    INTEGRITY: 'integrity',
});

// ── Stable machine codes. ────────────────────────────────────────────────────
const CODE = Object.freeze({
    // Field-mismatch codes (rules engine).
    QUANTITY_MISMATCH: 'QUANTITY_MISMATCH',
    WEIGHT_MISMATCH: 'WEIGHT_MISMATCH',
    ADDRESS_MISMATCH: 'ADDRESS_MISMATCH',
    CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
    TAX_MISMATCH: 'TAX_MISMATCH',
    // Completeness codes.
    MISSING_FIELD: 'MISSING_FIELD',
    UNPARSEABLE_FIELD: 'UNPARSEABLE_FIELD',
    // Integrity / plausibility codes (AI + rules).
    IMPLAUSIBLE_VALUE: 'IMPLAUSIBLE_VALUE',
    // Classification codes (AI layer).
    DOC_TYPE_MISMATCH: 'DOC_TYPE_MISMATCH',
    LOW_CONFIDENCE_EXTRACTION: 'LOW_CONFIDENCE_EXTRACTION',
    UNCLASSIFIED_DOCUMENT: 'UNCLASSIFIED_DOCUMENT',
});

// ── Overall report verdicts. ─────────────────────────────────────────────────
const STATUS = Object.freeze({
    PASSED: 'passed',
    PASSED_WITH_WARNINGS: 'passed_with_warnings',
    FAILED: 'failed',
});

const VALID_SOURCES = Object.freeze(['rules', 'ai']);

const clampConfidence = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
};

/**
 * Build a normalized finding. The single choke-point both the rules engine and
 * the AI layer use, so every entry in the report is shape-identical.
 *
 * @param {object} f
 * @returns {object} a frozen finding
 */
function finding(f = {}) {
    const {
        code,
        category,
        severity = SEVERITY.MEDIUM,
        field = null,
        expected = null,
        actual = null,
        delta = null,
        unit = null,
        confidence = 100,
        source = 'rules',
        message = '',
    } = f;

    if (!code) throw new Error('finding(): `code` is required');
    if (!Object.values(CATEGORY).includes(category)) {
        throw new Error(`finding(): unknown category '${category}'`);
    }
    if (!SEVERITY_ORDER.includes(severity)) {
        throw new Error(`finding(): unknown severity '${severity}'`);
    }
    if (!VALID_SOURCES.includes(source)) {
        throw new Error(`finding(): unknown source '${source}'`);
    }

    return Object.freeze({
        code,
        category,
        severity,
        field,
        expected,
        actual,
        delta,
        unit,
        confidence: clampConfidence(confidence),
        source,
        message,
    });
}

module.exports = {
    SEVERITY,
    SEVERITY_ORDER,
    SEVERITY_PENALTY,
    severityRank,
    CATEGORY,
    CODE,
    STATUS,
    VALID_SOURCES,
    clampConfidence,
    finding,
};
