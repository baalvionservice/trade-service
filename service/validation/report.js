'use strict';
/**
 * AI Document Validation Engine — REPORT builder + READINESS IMPACT (Prompt 5).
 *
 * PURE: no DB, no I/O. Folds the rules-engine findings and the AI-layer findings
 * into the single `validation_report` JSON the prompt asks for, then derives the
 * readiness IMPACT — a 0–100 score (with a documentation-component multiplier and
 * a suggested penalty delta) the dashboard readiness scorer can fold in.
 *
 * validation_report shape:
 * {
 *   engine_version, generated_at, document: {...}, classification: {...},
 *   status: passed | passed_with_warnings | failed,
 *   confidence: 0..100,
 *   summary: { total, by_severity:{...}, by_category:{...}, by_source:{...} },
 *   findings: [ finding, ... ],            // sorted worst-first
 *   readiness_impact: {
 *     score, band, documentation_multiplier, suggested_delta, blocking, reasons[]
 *   }
 * }
 */

const {
    SEVERITY, SEVERITY_ORDER, SEVERITY_PENALTY, severityRank, CATEGORY, STATUS,
} = require('./schema');

const ENGINE_VERSION = '1.0.0';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round2 = (n) => Math.round(n * 100) / 100;

function emptyCounts(keys) {
    return keys.reduce((acc, k) => { acc[k] = 0; return acc; }, {});
}

/** Worst severity present across findings (or null). */
function worstSeverity(findings) {
    let worst = null;
    let worstR = -1;
    for (const f of findings) {
        const r = severityRank(f.severity);
        if (r > worstR) { worstR = r; worst = f.severity; }
    }
    return worst;
}

/** Verdict from the worst severity present. */
function statusFor(findings) {
    const worst = worstSeverity(findings);
    if (worst === SEVERITY.CRITICAL || worst === SEVERITY.HIGH) return STATUS.FAILED;
    if (worst === SEVERITY.MEDIUM || worst === SEVERITY.LOW) return STATUS.PASSED_WITH_WARNINGS;
    return STATUS.PASSED; // no findings, or info-only
}

/**
 * Overall confidence (0–100) in the VERDICT.
 *  - Clean pass: confidence tracks the classification confidence (how sure we are
 *    we even understood the document) blended with a completeness prior.
 *  - With findings: confidence is the severity-weighted mean of the findings'
 *    own confidences — we report how sure we are about the problems we raised.
 */
function overallConfidence(findings, classification) {
    if (findings.length === 0) {
        const cls = classification && Number.isFinite(classification.confidence)
            ? classification.confidence : 70;
        // A confidently-classified, finding-free document is high-confidence pass.
        return clamp(Math.round(0.5 * cls + 50));
    }
    let weightSum = 0;
    let acc = 0;
    for (const f of findings) {
        const w = severityRank(f.severity) + 1; // info=1 … critical=5
        weightSum += w;
        acc += w * f.confidence;
    }
    return clamp(Math.round(acc / weightSum));
}

/**
 * Readiness impact. Starts from a perfect 100 and subtracts a penalty per
 * finding by severity; CRITICAL zeroes it. The multiplier (score/100) is meant
 * to scale this document's contribution to the dashboard's `documentation`
 * readiness component, and `suggested_delta` is the raw point penalty.
 */
function readinessImpact(findings, status) {
    let penalty = 0;
    const reasons = [];
    for (const f of findings) {
        const p = SEVERITY_PENALTY[f.severity] || 0;
        if (p > 0) {
            penalty += p;
            reasons.push({ code: f.code, severity: f.severity, field: f.field, penalty: p });
        }
    }
    const score = clamp(100 - penalty);
    const band = score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low';
    return {
        score: round2(score),
        band,
        documentation_multiplier: round2(score / 100),
        suggested_delta: -Math.min(100, penalty),
        blocking: status === STATUS.FAILED,
        reasons,
    };
}

/** Stable worst-first ordering: severity desc, then source (rules before ai). */
function sortFindings(findings) {
    return [...findings].sort((a, b) => {
        const d = severityRank(b.severity) - severityRank(a.severity);
        if (d !== 0) return d;
        if (a.source !== b.source) return a.source === 'rules' ? -1 : 1;
        return 0;
    });
}

/**
 * Build the full validation_report.
 *
 * @param {object} input
 * @param {object} [input.document]       Light document descriptor for the report header.
 * @param {object[]} [input.ruleFindings] Findings from rules.run().findings.
 * @param {object} [input.classification] Result from aiClassifier.classify().
 * @param {Date}   [input.now]            Injected clock (determinism).
 * @returns {object} validation_report
 */
function build({ document = null, ruleFindings = [], classification = null, now = new Date() } = {}) {
    const aiFindings = (classification && classification.findings) || [];
    const findings = sortFindings([...ruleFindings, ...aiFindings]);

    const status = statusFor(findings);
    const confidence = overallConfidence(findings, classification);

    const by_severity = emptyCounts(SEVERITY_ORDER);
    const by_category = emptyCounts(Object.values(CATEGORY));
    const by_source = { rules: 0, ai: 0 };
    for (const f of findings) {
        by_severity[f.severity] += 1;
        if (by_category[f.category] !== undefined) by_category[f.category] += 1;
        if (by_source[f.source] !== undefined) by_source[f.source] += 1;
    }

    return {
        engine_version: ENGINE_VERSION,
        generated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
        document: document || null,
        classification: classification
            ? {
                doc_type: classification.docType,
                confidence: classification.confidence,
                provider: classification.provider || null,
                degraded: !!classification.degraded,
            }
            : null,
        status,
        confidence,
        summary: {
            total: findings.length,
            by_severity,
            by_category,
            by_source,
        },
        findings,
        readiness_impact: readinessImpact(findings, status),
    };
}

module.exports = {
    build,
    statusFor,
    overallConfidence,
    readinessImpact,
    worstSeverity,
    sortFindings,
    ENGINE_VERSION,
};
