'use strict';
/**
 * Compliance AI Agent (War Room 4, Prompt 13) — public surface.
 *
 * An AI AGENT that scans a shipment, detects risks, flags compliance issues and
 * EXPLAINS its reasoning — built as a RULE + AI HYBRID over the Prompt 8
 * Compliance & Sanctions Engine, with first-class confidence scoring and
 * explainability output.
 *
 *   schema       vocabulary (RISK_CATEGORY / SOURCE / SEVERITY / AGENT_DECISION /
 *                confidence bands) + finding() / reasoningStep() factories
 *   signals      PURE shipment scanner — distils a shipment into the canonical
 *                screening subject + a narratable signal list
 *   ruleAnalyzer PURE rule layer — REUSES the Prompt 8 rules engine, maps each
 *                violation + KYC/AML verdict into a high-confidence finding
 *   aiAnalyzer   PLUGGABLE AI risk layer (heuristic default) — probabilistic
 *                findings (jurisdiction / route / valuation / misclassification /
 *                data-gap / AML-pattern) with confidence + rationale
 *   fusion       PURE hybrid combiner — corroborates rule + AI, computes the
 *                overall risk_score / risk_level / decision / confidence
 *   explain      PURE explainability — reasoning chain + narrative + per-finding
 *                "why" factors
 *   agent        DB-backed orchestrator (assess / assessShipment / getLatest /
 *                listHistory / triggerAssess) with reference-data + tenant-list
 *                loading + caching + append-only persistence
 */
module.exports = {
    schema: require('./schema'),
    signals: require('./signals'),
    ruleAnalyzer: require('./ruleAnalyzer'),
    aiAnalyzer: require('./aiAnalyzer'),
    fusion: require('./fusion'),
    explain: require('./explain'),
    agent: require('./agent'),
};
