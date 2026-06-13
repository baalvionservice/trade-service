'use strict';
/**
 * Compliance AI Agent — EXPLAINABILITY (Prompt 13).
 *
 * PURE: no DB, no I/O. Turns the agent's internal work (scan → rule layer → AI
 * layer → fusion) into the first-class EXPLAINABILITY OUTPUT the prompt requires:
 *
 *   • reasoning  — an ordered, numbered chain of steps the agent took, each
 *                  linked to the finding ids it produced, so a human can audit
 *                  *how* the verdict was reached, not just *what* it is.
 *   • narrative  — a plain-language paragraph summarising the verdict, the
 *                  decisive risks, the rule-vs-AI split and the confidence.
 *   • factors    — the per-finding "why": category, what tripped it, the evidence
 *                  and how confident the agent is in THAT finding.
 *
 * Explainability is built from the SAME finding objects the score is built from,
 * so the explanation can never drift from the decision it explains.
 */

const { reasoningStep, SOURCE, AGENT_DECISION } = require('./schema');

const DECISION_PHRASE = Object.freeze({
    [AGENT_DECISION.CLEAR]: 'cleared — no actionable compliance risk detected',
    [AGENT_DECISION.MONITOR]: 'cleared with monitoring — only weak, low-severity signals',
    [AGENT_DECISION.REVIEW]: 'flagged for human compliance review',
    [AGENT_DECISION.BLOCK]: 'BLOCKED — a hard compliance violation was found',
});

/**
 * Assemble the full reasoning chain.
 *
 * @param {object} input
 * @param {object} input.scan      output of signals.scan ({ subject, signals, ... })
 * @param {object[]} input.ruleSteps  reasoning steps the rule layer emitted
 * @param {object} input.ai        AI layer result ({ provider, findings, reasoning, degraded })
 * @param {object} input.fusion    output of fusion.fuse
 * @returns {object[]} ordered reasoning steps
 */
function buildReasoning({ scan, ruleSteps = [], ai = {}, fusion = {} } = {}) {
    const steps = [];
    let n = 1;
    const push = (s) => steps.push(reasoningStep({ ...s, step: n++ }));

    // 1. Scan.
    const countries = scan.scanned_countries || [];
    push({
        phase: 'scan',
        summary: `Scanned the shipment: ${countries.length} jurisdiction(s) [${countries.join(', ') || 'none'}], ${(scan.subject.parties || []).length} party(ies), ${(scan.subject.goods || []).length} goods line(s).`,
        detail: (scan.signals || []).map((s) => s.label).slice(0, 8).join('; '),
    });

    // 2. Rule layer (carry through the steps it produced, re-numbered).
    for (const rs of ruleSteps) {
        push({ phase: 'rule', summary: rs.summary, detail: rs.detail, finding_ids: rs.finding_ids });
    }

    // 3. AI layer.
    push({
        phase: 'ai',
        summary: ai.degraded
            ? `AI risk layer unavailable (${ai.provider}); proceeding on the rule layer alone.`
            : `AI risk layer (${ai.provider}) inferred ${(ai.findings || []).length} probabilistic signal(s).`,
        detail: ai.reasoning || null,
        finding_ids: (ai.findings || []).map((f) => f.id),
    });

    // 4. Fusion / corroboration.
    const hybridCount = (fusion.findings || []).filter((f) => f.source === SOURCE.HYBRID).length;
    push({
        phase: 'fusion',
        summary: `Fused rule + AI findings: ${fusion.by_source ? fusion.by_source.rule : 0} rule, ${fusion.by_source ? fusion.by_source.ai : 0} AI, ${hybridCount} corroborated (hybrid).`,
        detail: hybridCount
            ? 'Corroborated findings (rule and AI independently agreeing) carry boosted confidence.'
            : 'No cross-layer corroboration; findings stand on their originating layer.',
    });

    // 5. Verdict.
    push({
        phase: 'decision',
        summary: `Verdict: ${fusion.decision} (risk ${fusion.risk_score}/100, level '${fusion.risk_level}', confidence ${fusion.confidence}%).`,
        detail: decisionRationale(fusion),
        finding_ids: (fusion.top_risks || []).map((r) => r.id),
    });

    return steps;
}

/** One-line rationale for WHY this decision (cites the decisive finding). */
function decisionRationale(fusion) {
    const top = (fusion.top_risks || [])[0];
    if (fusion.decision === AGENT_DECISION.BLOCK) {
        return top ? `Hard stop driven by ${top.category} ("${top.title}"${top.subject ? `: ${top.subject}` : ''}).` : 'Hard compliance violation present.';
    }
    if (fusion.decision === AGENT_DECISION.REVIEW) {
        return top ? `Human review needed: highest risk is ${top.category} ("${top.title}", ${top.source}, confidence ${top.confidence}%).` : 'Actionable risk requires review.';
    }
    if (fusion.decision === AGENT_DECISION.MONITOR) {
        return 'Only low-severity / low-confidence signals; proceed while monitoring.';
    }
    return 'No actionable risk across the rule or AI layers.';
}

/** Per-finding "why" factors (the explainability detail behind each risk). */
function buildFactors(fusion) {
    return (fusion.findings || []).map((f) => ({
        id: f.id,
        category: f.category,
        source: f.source,
        severity: f.severity,
        confidence: f.confidence,
        confidence_band: f.confidence_band,
        why: f.rationale,
        evidence: f.evidence,
        recommendation: f.recommendation,
        corroborated_by: f.corroborated_by,
    }));
}

/** A plain-language narrative summarising the whole assessment. */
function buildNarrative({ scan, ai = {}, fusion = {} } = {}) {
    const route = (scan.subject.originCountry || '?') + ' → ' + (scan.subject.destinationCountry || '?');
    const verdict = DECISION_PHRASE[fusion.decision] || fusion.decision;
    const parts = [];
    parts.push(`The Compliance AI Agent scanned this shipment (${route}) and ${verdict}.`);
    parts.push(`Overall risk is ${fusion.risk_score}/100 (${fusion.risk_level}), assessed with ${fusion.confidence}% confidence.`);

    const top = (fusion.top_risks || []);
    if (top.length) {
        const lead = top[0];
        parts.push(`The decisive risk is ${lead.category.replace(/_/g, ' ')} ("${lead.title}"${lead.subject ? `: ${lead.subject}` : ''}), raised by the ${lead.source} layer at ${lead.confidence}% confidence.`);
        if (top.length > 1) {
            parts.push(`${top.length - 1} further risk(s) were noted: ${top.slice(1).map((r) => r.category.replace(/_/g, ' ')).join(', ')}.`);
        }
    } else {
        parts.push('Neither the deterministic rule layer nor the AI risk layer surfaced an actionable concern.');
    }

    const bs = fusion.by_source || {};
    parts.push(`This verdict combines a deterministic rule layer (${bs.rule || 0} finding(s)) with an AI risk layer (${bs.ai || 0} finding(s)); ${bs.hybrid || 0} were corroborated by both${ai.degraded ? ', though the AI layer was degraded for this run' : ''}.`);

    if (fusion.decision === AGENT_DECISION.CLEAR && fusion.confidence < 75) {
        parts.push('Note: confidence in this clear verdict is reduced by gaps in the supplied identity/classification data.');
    }
    return parts.join(' ');
}

/**
 * Build the complete explainability block.
 * @returns {{ reasoning, narrative, factors, decision_rationale }}
 */
function build({ scan, ruleSteps = [], ai = {}, fusion = {} } = {}) {
    return {
        reasoning: buildReasoning({ scan, ruleSteps, ai, fusion }),
        narrative: buildNarrative({ scan, ai, fusion }),
        decision_rationale: decisionRationale(fusion),
        factors: buildFactors(fusion),
    };
}

module.exports = {
    build,
    buildReasoning,
    buildNarrative,
    buildFactors,
    decisionRationale,
    DECISION_PHRASE,
};
