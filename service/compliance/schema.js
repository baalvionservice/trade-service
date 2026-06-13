'use strict';
/**
 * Compliance & Sanctions Engine — VOCABULARY + factories (War Room 4, Prompt 8).
 *
 * PURE: no DB, no I/O. The shared enums every layer agrees on (decisions,
 * severities, check identifiers, violation codes) plus small factories so a
 * violation / check-result is always shaped the same way. Keeping this in one
 * module means the rules engine, the severity scorer, the report builder and the
 * persisted columns never drift apart.
 */

// Overall screening decision (rolled up from the worst violation + risk score).
const DECISION = Object.freeze({
    CLEAR: 'clear', // nothing actionable — trade may proceed
    REVIEW: 'review', // a human must look before proceeding
    BLOCK: 'block', // a hard violation — trade must not proceed
});

// Severity ladder, lowest → highest. `none` is the empty/clean severity.
const SEVERITY = Object.freeze({
    NONE: 'none',
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical',
});

// Numeric rank so severities can be compared / max-reduced deterministically.
const SEVERITY_RANK = Object.freeze({
    none: 0, low: 1, medium: 2, high: 3, critical: 4,
});

// The discrete checks the rules engine runs. Each violation tags its origin check
// so a caller can see exactly which gate it tripped.
const CHECK = Object.freeze({
    SANCTIONED_COUNTRY: 'sanctioned_country',
    SANCTIONED_PARTY: 'sanctioned_party',
    RESTRICTED_GOODS: 'restricted_goods',
    DUAL_USE_GOODS: 'dual_use_goods',
    PROHIBITED_GOODS: 'prohibited_goods',
    TRADE_BAN: 'trade_ban',
    BLACKLIST: 'blacklist',
    WHITELIST: 'whitelist',
    KYC: 'kyc',
    AML: 'aml',
});

const ALL_CHECKS = Object.freeze(Object.values(CHECK));

// Trade direction relative to the screening subject's home jurisdiction.
const DIRECTION = Object.freeze({ EXPORT: 'export', IMPORT: 'import', BOTH: 'both' });

// KYC / AML hook verdicts (mirror the persisted column CHECK constraints).
const HOOK_STATUS = Object.freeze({
    NOT_CHECKED: 'not_checked',
    PENDING: 'pending',
    PASSED: 'passed',
    FAILED: 'failed',
    REVIEW: 'review',
});

const isSeverity = (s) => Object.prototype.hasOwnProperty.call(SEVERITY_RANK, s);

/** The higher-ranked of two severities (deterministic max). */
function maxSeverity(a, b) {
    const ra = SEVERITY_RANK[a] ?? 0;
    const rb = SEVERITY_RANK[b] ?? 0;
    return ra >= rb ? (isSeverity(a) ? a : SEVERITY.NONE) : b;
}

/**
 * Build a normalized violation record. Every rule emits violations through here
 * so the shape is invariant across checks.
 *
 * @param {object} v
 * @param {string} v.check     one of CHECK
 * @param {string} v.code      a stable machine code (e.g. SANCTIONED_COUNTRY_MATCH)
 * @param {string} v.severity  one of SEVERITY
 * @param {string} v.message   human-readable explanation
 * @param {string} [v.subject] the offending value (country / party / good)
 * @param {object} [v.details] structured extra context
 */
function violation({ check, code, severity = SEVERITY.MEDIUM, message, subject = null, details = {} }) {
    return {
        check,
        code,
        severity: isSeverity(severity) ? severity : SEVERITY.MEDIUM,
        message: message || code,
        subject: subject != null ? String(subject) : null,
        details: details || {},
    };
}

module.exports = {
    DECISION,
    SEVERITY,
    SEVERITY_RANK,
    CHECK,
    ALL_CHECKS,
    DIRECTION,
    HOOK_STATUS,
    isSeverity,
    maxSeverity,
    violation,
};
