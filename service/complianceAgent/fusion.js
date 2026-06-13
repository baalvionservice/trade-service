'use strict';
/**
 * Compliance AI Agent — HYBRID FUSION (Prompt 13).
 *
 * PURE: no DB, no I/O. The heart of the "rule + AI hybrid system": it merges the
 * deterministic rule findings with the probabilistic AI findings into ONE risk
 * picture, with per-finding + overall CONFIDENCE and an advisory DECISION.
 *
 * Fusion principles (auditable + safe):
 *   • Corroboration boosts confidence. When the rule layer AND the AI layer
 *     independently flag the same subject (or the AI flags a jurisdiction the rule
 *     also hit), the finding becomes a HYBRID and its confidence rises — two
 *     independent signals agreeing is stronger than either alone.
 *   • The AI layer never invents OR clears a hard violation. Only a rule-grounded
 *     finding (sanctions / ban / prohibited / blacklist / failed KYC-AML) can
 *     drive a BLOCK. An AI finding can raise the picture to REVIEW/MONITOR but, on
 *     its own, can never block — that protects against model false-positives
 *     halting legitimate trade, and against a model false-negative clearing a real
 *     hit (the rules still fire regardless).
 *   • Confidence in a 'clear' verdict is discounted by data gaps — the agent is
 *     honest that "nothing found" on thin data is a weaker statement.
 */

const {
    SOURCE, SEVERITY, SEVERITY_RANK, maxSeverity, AGENT_DECISION, worseDecision,
    RULE_GROUNDED, RISK_CATEGORY, clampConfidence, confidenceBand, finding,
} = require('./schema');

// Additive risk points per severity (mirrors compliance/severity.js so the agent's
// 0..100 scale lines up with the Prompt 8 engine's risk_score).
const SEVERITY_POINTS = Object.freeze({ none: 0, low: 10, medium: 25, high: 50, critical: 100 });

// An AI-only finding contributes its severity points scaled by confidence and a
// damping factor — probabilistic signals move the score but don't saturate it.
const AI_SCORE_DAMPING = 0.6;

// AI finding thresholds that escalate the overall decision.
const AI_REVIEW_MIN_CONFIDENCE = 62;

// Corroboration bonus (added to the higher of the two confidences, capped at 99).
const CORROBORATION_BONUS = 10;

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round2 = (n) => Math.round(n * 100) / 100;

/** Country codes a finding implicates (subject + structured refs). */
function findingCountries(f) {
    const out = new Set();
    const refs = f.refs || {};
    for (const key of ['jurisdictions', 'risky_legs', 'transit']) {
        if (Array.isArray(refs[key])) refs[key].forEach((c) => c && out.add(String(c).toUpperCase()));
    }
    if (refs.destination) out.add(String(refs.destination).toUpperCase());
    // A 2-letter subject is very likely a country code.
    if (f.subject && /^[a-z]{2}$/i.test(f.subject.trim())) out.add(f.subject.trim().toUpperCase());
    return out;
}

/** Merge a rule finding + an AI finding on the same id into one hybrid finding. */
function mergeHybrid(ruleF, aiF) {
    const severity = maxSeverity(ruleF.severity, aiF.severity);
    const confidence = clampConfidence(Math.max(ruleF.confidence, aiF.confidence) + CORROBORATION_BONUS);
    return finding({
        category: ruleF.category,
        source: SOURCE.HYBRID,
        severity,
        confidence,
        title: ruleF.title,
        subject: ruleF.subject,
        rationale: `${ruleF.rationale} — independently corroborated by the AI risk layer: ${aiF.rationale}`,
        evidence: [...new Set([...ruleF.evidence, ...aiF.evidence])],
        recommendation: ruleF.recommendation || aiF.recommendation,
        corroborated_by: [SOURCE.RULE, SOURCE.AI],
        refs: { ...aiF.refs, ...ruleF.refs, corroborated: true },
    });
}

/** Re-issue a finding with extra cross-layer corroboration (confidence bump). */
function withCorroboration(f, bySource) {
    return finding({
        category: f.category,
        source: f.source,
        severity: f.severity,
        confidence: clampConfidence(f.confidence + Math.round(CORROBORATION_BONUS / 2)),
        title: f.title,
        subject: f.subject,
        rationale: `${f.rationale} (corroborated by the ${bySource} layer on the same jurisdiction)`,
        evidence: f.evidence,
        recommendation: f.recommendation,
        corroborated_by: [...new Set([...f.corroborated_by, bySource])],
        refs: { ...f.refs, corroborated: true },
    });
}

/**
 * Fuse rule + AI findings into the unified finding set.
 * @returns {object[]} fused findings (hybrid where corroborated)
 */
function fuseFindings(ruleFindings = [], aiFindings = []) {
    const ruleById = new Map(ruleFindings.map((f) => [f.id, f]));
    const aiById = new Map(aiFindings.map((f) => [f.id, f]));

    const fused = [];
    const consumedAi = new Set();

    // 1. Exact same-id matches → hybrid.
    for (const ruleF of ruleFindings) {
        const aiF = aiById.get(ruleF.id);
        if (aiF) { fused.push(mergeHybrid(ruleF, aiF)); consumedAi.add(aiF.id); }
        else fused.push(ruleF);
    }

    // 2. Cross-jurisdiction corroboration: an AI finding on a country the rule
    //    layer also hit reinforces BOTH — bump the rule finding's confidence and
    //    keep the AI finding (it adds distinct context). Only applies to the
    //    country-bearing rule categories.
    const ruleCountryFindings = fused.filter((f) =>
        (f.source === SOURCE.RULE || f.source === SOURCE.HYBRID)
        && (f.category === RISK_CATEGORY.SANCTIONED_COUNTRY || f.category === RISK_CATEGORY.TRADE_BAN));
    const ruleCountrySet = new Set();
    for (const f of ruleCountryFindings) findingCountries(f).forEach((c) => ruleCountrySet.add(c));

    for (const aiF of aiFindings) {
        if (consumedAi.has(aiF.id)) continue;
        const aiCountries = findingCountries(aiF);
        const overlaps = [...aiCountries].some((c) => ruleCountrySet.has(c));
        fused.push(overlaps ? withCorroboration(aiF, SOURCE.RULE) : aiF);
    }

    // Sort: severity desc, then confidence desc, for stable "top risks".
    fused.sort((a, b) =>
        (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.confidence - a.confidence));
    return fused;
}

/** Does this finding hard-block (rule-grounded critical / failed KYC-AML)? */
function isBlocking(f) {
    if (!RULE_GROUNDED.has(f.category)) return false; // AI-only never blocks
    if (f.source === SOURCE.AI) return false;
    if (f.severity === SEVERITY.CRITICAL) return true;
    if (f.category === RISK_CATEGORY.KYC_AML && f.refs && f.refs.status === 'failed') return true;
    return false;
}

/** A finding is "actionable" when severity > none. */
function isActionable(f) {
    return (SEVERITY_RANK[f.severity] ?? 0) > 0;
}

/** Overall 0..100 risk score from the fused findings. */
function computeRiskScore(findings) {
    let points = 0;
    for (const f of findings) {
        if (!isActionable(f)) continue;
        const base = SEVERITY_POINTS[f.severity] ?? 0;
        if (f.source === SOURCE.AI) {
            points += base * AI_SCORE_DAMPING * (f.confidence / 100);
        } else {
            points += base; // rule + hybrid count at full weight
        }
    }
    return round2(clamp(points));
}

/** Overall advisory decision from the fused findings. */
function computeDecision(findings) {
    let decision = AGENT_DECISION.CLEAR;
    for (const f of findings) {
        if (!isActionable(f)) continue;
        if (isBlocking(f)) { decision = worseDecision(decision, AGENT_DECISION.BLOCK); continue; }
        const ruleGrounded = (f.source === SOURCE.RULE || f.source === SOURCE.HYBRID) && RULE_GROUNDED.has(f.category);
        if (ruleGrounded) {
            // A non-critical rule violation always needs human review.
            decision = worseDecision(decision, AGENT_DECISION.REVIEW);
        } else if ((SEVERITY_RANK[f.severity] >= SEVERITY_RANK[SEVERITY.MEDIUM]) && f.confidence >= AI_REVIEW_MIN_CONFIDENCE) {
            decision = worseDecision(decision, AGENT_DECISION.REVIEW);
        } else {
            // Low-severity / low-confidence AI signal → proceed but monitor.
            decision = worseDecision(decision, AGENT_DECISION.MONITOR);
        }
    }
    return decision;
}

/**
 * Confidence in the OVERALL assessment (0..100): how sure the agent is about the
 * risk picture it is reporting — distinct from per-finding confidence.
 *   • risk present → confidence tracks the strongest corroborated finding.
 *   • clear        → starts high, discounted by data gaps (thin data ⇒ weak clear).
 */
function computeAssessmentConfidence(findings, { dataGap = false } = {}) {
    const actionable = findings.filter(isActionable);
    if (actionable.length === 0) {
        // A clean result is only as trustworthy as the data behind it.
        return clampConfidence(dataGap ? 62 : 88);
    }
    const top = actionable[0]; // already sorted severity↓ confidence↓
    let conf = top.confidence;
    if (top.source === SOURCE.HYBRID) conf = Math.max(conf, 90); // two independent signals
    // More corroborating findings → marginally higher certainty there IS risk.
    const corroborated = actionable.filter((f) => f.corroborated_by.length > 0).length;
    conf = clampConfidence(conf + Math.min(corroborated * 2, 6));
    return conf;
}

/**
 * Fuse everything into the agent's risk summary.
 *
 * @param {object} input
 * @param {object[]} input.ruleFindings
 * @param {object[]} input.aiFindings
 * @param {boolean} [input.dataGap]  whether the scan flagged identity/classification gaps
 * @returns {object} { findings, risk_score, risk_level, severity, decision,
 *                     confidence, confidence_band, blocking, counts, top_risks }
 */
function fuse({ ruleFindings = [], aiFindings = [], dataGap = false } = {}) {
    const findings = fuseFindings(ruleFindings, aiFindings);
    const actionable = findings.filter(isActionable);

    const riskScore = computeRiskScore(findings);
    const decision = computeDecision(findings);
    const confidence = computeAssessmentConfidence(findings, { dataGap });

    let severity = SEVERITY.NONE;
    const counts = { none: 0, low: 0, medium: 0, high: 0, critical: 0 };
    const bySource = { rule: 0, ai: 0, hybrid: 0 };
    const byCategory = {};
    for (const f of findings) {
        if (isActionable(f)) severity = maxSeverity(severity, f.severity);
        counts[f.severity] = (counts[f.severity] || 0) + 1;
        bySource[f.source] = (bySource[f.source] || 0) + 1;
        byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }

    return {
        findings,
        risk_score: riskScore,
        risk_level: riskLevel(riskScore),
        severity,
        decision,
        blocking: decision === AGENT_DECISION.BLOCK,
        confidence,
        confidence_band: confidenceBand(confidence),
        finding_count: actionable.length,
        counts,
        by_source: bySource,
        by_category: byCategory,
        top_risks: actionable.slice(0, 5).map((f) => ({
            id: f.id, category: f.category, source: f.source, severity: f.severity,
            confidence: f.confidence, title: f.title, subject: f.subject,
        })),
    };
}

/** Map a 0..100 risk score to a coarse human risk band. */
function riskLevel(score) {
    if (score >= 80) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'moderate';
    if (score > 0) return 'low';
    return 'minimal';
}

module.exports = {
    fuse,
    fuseFindings,
    mergeHybrid,
    computeRiskScore,
    computeDecision,
    computeAssessmentConfidence,
    isBlocking,
    isActionable,
    riskLevel,
    findingCountries,
    SEVERITY_POINTS,
    AI_SCORE_DAMPING,
    AI_REVIEW_MIN_CONFIDENCE,
    CORROBORATION_BONUS,
};
