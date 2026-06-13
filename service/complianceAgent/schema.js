'use strict';
/**
 * Compliance AI Agent — VOCABULARY + FACTORIES (War Room 4, Prompt 13).
 *
 * PURE: no DB, no I/O, no clock. The single stable vocabulary every layer of the
 * AGENT speaks — risk categories, finding sources (rule / ai / hybrid), severity +
 * confidence bands, the agent decision ladder — plus the `finding()` and
 * `reasoningStep()` factories every producer funnels through, so the emitted
 * `compliance_assessment` is shape-identical regardless of which layer (rule
 * analyzer, AI analyzer, fusion) raised it.
 *
 * This is the AI AGENT that sits ABOVE the deterministic Compliance & Sanctions
 * Engine (Prompt 8). It scans a shipment, runs BOTH a rule layer (the Prompt 8
 * engine, high-certainty) and a pluggable AI layer (probabilistic risk inference),
 * FUSES them into one risk picture with per-finding + overall confidence, and
 * explains its reasoning. The two halves are deliberately separated so the hybrid
 * is auditable: a caller can always see what the rules asserted vs. what the model
 * inferred, and how the agent combined them.
 *
 * A FINDING is the atomic unit of the agent's risk picture:
 *   {
 *     id:             stable composite key  `${category}:${subjectKey}`
 *     category:       RISK_CATEGORY.*       — the kind of risk
 *     source:         SOURCE.*              — rule | ai | hybrid (who raised it)
 *     severity:       SEVERITY.*            — none..critical (how bad)
 *     confidence:     0..100                — how SURE the agent is it is real
 *     confidence_band: band(confidence)
 *     title:          short headline
 *     subject:        the offending value (country / party / good / route)
 *     rationale:      WHY it was flagged (the reasoning, human-readable)
 *     evidence:       [string]              — the concrete signals supporting it
 *     recommendation: the suggested action
 *     corroborated_by:[SOURCE.*]            — layers that independently agree
 *     refs:           { rule_code?, signal?, regime? ... } structured links
 *   }
 *
 * A REASONING STEP is one line of the agent's explainability chain:
 *   { step, phase, summary, detail, finding_ids:[...] }
 */

// ── Severity ladder (aligned with the Prompt 8 engine for cross-layer folds). ─
const SEVERITY = Object.freeze({
    NONE: 'none',
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical',
});

const SEVERITY_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3, critical: 4 });

/** The higher-ranked of two severities (deterministic max). */
function maxSeverity(a, b) {
    const ra = SEVERITY_RANK[a] ?? 0;
    const rb = SEVERITY_RANK[b] ?? 0;
    if (ra >= rb) return SEVERITY_RANK[a] !== undefined ? a : SEVERITY.NONE;
    return SEVERITY_RANK[b] !== undefined ? b : SEVERITY.NONE;
}

// ── Where a finding came from. ───────────────────────────────────────────────
const SOURCE = Object.freeze({
    RULE: 'rule',   // the deterministic Prompt 8 compliance/sanctions rules
    AI: 'ai',       // the pluggable AI risk-inference layer (probabilistic)
    HYBRID: 'hybrid', // rule + AI independently agreed → corroborated
});

// ── The risk categories the agent reasons about. The first block maps 1:1 onto
// the Prompt 8 rule checks; the second block is the AI layer's value-add (risks a
// flat rules engine can't catch — anomalies, gaps, behavioural patterns). ──────
const RISK_CATEGORY = Object.freeze({
    // Rule-grounded categories.
    SANCTIONED_COUNTRY: 'sanctioned_country',
    SANCTIONED_PARTY: 'sanctioned_party',
    RESTRICTED_GOODS: 'restricted_goods',
    DUAL_USE_GOODS: 'dual_use_goods',
    PROHIBITED_GOODS: 'prohibited_goods',
    TRADE_BAN: 'trade_ban',
    BLACKLIST: 'blacklist',
    KYC_AML: 'kyc_aml',
    // AI-inferred categories.
    JURISDICTION_RISK: 'jurisdiction_risk',     // elevated-risk transit / nexus
    ROUTE_ANOMALY: 'route_anomaly',             // implausible / transshipment routing
    VALUATION_ANOMALY: 'valuation_anomaly',     // under/over-valuation, round-number flags
    GOODS_MISCLASSIFICATION: 'goods_misclassification', // vague/evasive goods description
    DOCUMENTATION_GAP: 'documentation_gap',     // missing identity/classification data
    AML_PATTERN: 'aml_pattern',                 // structuring / high-value-into-high-risk
});

const ALL_CATEGORIES = Object.freeze(Object.values(RISK_CATEGORY));

// The categories that are HARD rule grounds — an AI layer may corroborate or
// contextualise these, but it can never invent OR clear them on its own.
const RULE_GROUNDED = Object.freeze(new Set([
    RISK_CATEGORY.SANCTIONED_COUNTRY,
    RISK_CATEGORY.SANCTIONED_PARTY,
    RISK_CATEGORY.RESTRICTED_GOODS,
    RISK_CATEGORY.DUAL_USE_GOODS,
    RISK_CATEGORY.PROHIBITED_GOODS,
    RISK_CATEGORY.TRADE_BAN,
    RISK_CATEGORY.BLACKLIST,
    RISK_CATEGORY.KYC_AML,
]));

// The agent's advisory decision (rolled up from the fused findings + confidence).
const AGENT_DECISION = Object.freeze({
    CLEAR: 'clear',     // no actionable risk — may proceed
    MONITOR: 'monitor', // low-confidence / low-severity AI signal — proceed, watch
    REVIEW: 'review',   // a human compliance officer must look before proceeding
    BLOCK: 'block',     // a hard (rule-grounded) violation — must not proceed
});

const DECISION_RANK = Object.freeze({ clear: 0, monitor: 1, review: 2, block: 3 });

/** The worse (higher-ranked) of two agent decisions. */
function worseDecision(a, b) {
    return (DECISION_RANK[a] ?? 0) >= (DECISION_RANK[b] ?? 0) ? a : b;
}

// ── Confidence bands. ────────────────────────────────────────────────────────
const CONFIDENCE_BAND = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });
const BAND_HIGH_MIN = 75;
const BAND_MEDIUM_MIN = 50;

const clampConfidence = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
};

/** Map a 0..100 confidence to its band. */
function confidenceBand(confidence) {
    const c = clampConfidence(confidence);
    if (c >= BAND_HIGH_MIN) return CONFIDENCE_BAND.HIGH;
    if (c >= BAND_MEDIUM_MIN) return CONFIDENCE_BAND.MEDIUM;
    return CONFIDENCE_BAND.LOW;
}

const isSeverity = (s) => Object.prototype.hasOwnProperty.call(SEVERITY_RANK, s);

/** A short, stable, lower-cased key for a finding subject (for dedup/fusion). */
function subjectKey(subject) {
    return String(subject == null ? '' : subject).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build a normalized finding — the single choke-point every producer uses, so a
 * rule finding, an AI finding and a fused finding are all the same shape.
 *
 * @param {object} f
 * @param {string} f.category   one of RISK_CATEGORY
 * @param {string} f.source     one of SOURCE
 * @param {string} f.severity   one of SEVERITY
 * @param {number} f.confidence 0..100
 * @param {string} f.title      short headline
 * @param {string} [f.subject]  the offending value
 * @param {string} f.rationale  WHY (the reasoning)
 * @param {string[]} [f.evidence]
 * @param {string} [f.recommendation]
 * @param {string[]} [f.corroborated_by]
 * @param {object} [f.refs]
 * @returns {object} a frozen finding
 */
function finding(f = {}) {
    const {
        category,
        source = SOURCE.AI,
        severity = SEVERITY.MEDIUM,
        confidence = 0,
        title,
        subject = null,
        rationale = '',
        evidence = [],
        recommendation = null,
        corroborated_by = [],
        refs = {},
    } = f;

    if (!category || !ALL_CATEGORIES.includes(category)) {
        throw new Error(`finding(): unknown category '${category}'`);
    }
    if (!Object.values(SOURCE).includes(source)) {
        throw new Error(`finding(): unknown source '${source}'`);
    }

    const conf = clampConfidence(confidence);
    const sev = isSeverity(severity) ? severity : SEVERITY.MEDIUM;
    const key = subjectKey(subject);
    return Object.freeze({
        id: `${category}:${key}`,
        category,
        source,
        severity: sev,
        confidence: conf,
        confidence_band: confidenceBand(conf),
        title: title || category,
        subject: subject != null ? String(subject) : null,
        rationale: String(rationale || ''),
        evidence: Object.freeze([...evidence]),
        recommendation: recommendation || null,
        corroborated_by: Object.freeze([...corroborated_by]),
        refs: Object.freeze({ ...refs }),
    });
}

/** Build a normalized reasoning step (one line of the explainability chain). */
function reasoningStep({ step, phase, summary, detail = null, finding_ids = [] } = {}) {
    return Object.freeze({
        step: Number(step) || 0,
        phase: phase || 'analysis',
        summary: String(summary || ''),
        detail: detail != null ? String(detail) : null,
        finding_ids: Object.freeze([...finding_ids]),
    });
}

module.exports = {
    SEVERITY,
    SEVERITY_RANK,
    maxSeverity,
    isSeverity,
    SOURCE,
    RISK_CATEGORY,
    ALL_CATEGORIES,
    RULE_GROUNDED,
    AGENT_DECISION,
    DECISION_RANK,
    worseDecision,
    CONFIDENCE_BAND,
    BAND_HIGH_MIN,
    BAND_MEDIUM_MIN,
    clampConfidence,
    confidenceBand,
    subjectKey,
    finding,
    reasoningStep,
};
