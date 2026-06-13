'use strict';
/**
 * Compliance & Sanctions Engine — SEVERITY SCORING + decision (Prompt 8).
 *
 * PURE: no DB, no I/O. Folds the rules engine's violation set (plus the KYC/AML
 * hook verdicts) into the three numbers a caller acts on:
 *
 *   • risk_score (0–100) — additive severity points, clamped. One critical
 *                          violation alone saturates the score to 100.
 *   • severity           — the single worst severity present (the headline).
 *   • decision           — clear / review / block (the gate).
 *
 * Decision policy (deterministic, worst-wins):
 *   block  — any actionable CRITICAL violation, or a failed KYC/AML hook.
 *   review — any actionable HIGH/MEDIUM/LOW violation, or a KYC/AML hook that
 *            is pending / needs review.
 *   clear  — nothing actionable (every violation whitelisted / no findings).
 */

const { DECISION, SEVERITY, SEVERITY_RANK, HOOK_STATUS, maxSeverity } = require('./schema');

// Additive risk points per severity. Tuned so a lone critical = 100 (saturates),
// while several mediums accumulate toward review/escalation.
const SEVERITY_POINTS = Object.freeze({
    none: 0,
    low: 10,
    medium: 25,
    high: 50,
    critical: 100,
});

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round2 = (n) => Math.round(n * 100) / 100;

/** A violation is "actionable" when it is not whitelisted (severity > none). */
function isActionable(v) {
    return !v.whitelisted && (SEVERITY_RANK[v.severity] ?? 0) > SEVERITY_RANK[SEVERITY.NONE];
}

/** Decision contribution of a KYC/AML hook status. */
function hookDecision(status) {
    if (status === HOOK_STATUS.FAILED) return DECISION.BLOCK;
    if (status === HOOK_STATUS.PENDING || status === HOOK_STATUS.REVIEW) return DECISION.REVIEW;
    return DECISION.CLEAR;
}

const DECISION_RANK = Object.freeze({ clear: 0, review: 1, block: 2 });
function worseDecision(a, b) {
    return (DECISION_RANK[a] ?? 0) >= (DECISION_RANK[b] ?? 0) ? a : b;
}

/**
 * Score a violation set into risk_score + severity + decision.
 *
 * @param {object[]} violations  output of rules.run().violations
 * @param {object} [signals]     { kycStatus, amlStatus } — KYC/AML hook verdicts
 * @returns {{ risk_score, severity, decision, blocking, actionable_count,
 *             whitelisted_count, counts, by_check }}
 */
function score(violations = [], signals = {}) {
    const actionable = violations.filter(isActionable);
    const whitelisted = violations.filter((v) => v.whitelisted);

    // Risk score — additive, clamped.
    let points = 0;
    let worstSeverity = SEVERITY.NONE;
    const counts = { none: 0, low: 0, medium: 0, high: 0, critical: 0 };
    const byCheck = {};
    for (const v of actionable) {
        points += SEVERITY_POINTS[v.severity] ?? 0;
        worstSeverity = maxSeverity(worstSeverity, v.severity);
        counts[v.severity] = (counts[v.severity] || 0) + 1;
        byCheck[v.check] = (byCheck[v.check] || 0) + 1;
    }
    const riskScore = round2(clamp(points));

    // Decision — worst of (violation-driven, KYC, AML).
    let decision = DECISION.CLEAR;
    if (worstSeverity === SEVERITY.CRITICAL) decision = DECISION.BLOCK;
    else if ((SEVERITY_RANK[worstSeverity] ?? 0) > 0) decision = DECISION.REVIEW;

    const kycDecision = hookDecision(signals.kycStatus);
    const amlDecision = hookDecision(signals.amlStatus);
    decision = worseDecision(decision, worseDecision(kycDecision, amlDecision));

    return {
        risk_score: riskScore,
        severity: worstSeverity,
        decision,
        blocking: decision === DECISION.BLOCK,
        actionable_count: actionable.length,
        whitelisted_count: whitelisted.length,
        counts,
        by_check: byCheck,
    };
}

module.exports = {
    score,
    isActionable,
    hookDecision,
    worseDecision,
    SEVERITY_POINTS,
    DECISION_RANK,
};
