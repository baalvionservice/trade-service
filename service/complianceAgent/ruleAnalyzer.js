'use strict';
/**
 * Compliance AI Agent — RULE LAYER (Prompt 13).
 *
 * PURE: no DB, no I/O. The deterministic, HIGH-CERTAINTY half of the hybrid. It
 * does NOT re-implement sanctions logic — it REUSES the Prompt 8 Compliance &
 * Sanctions rules engine (rules.run) verbatim and translates each emitted
 * `violation` into the agent's `finding` shape, plus folds the (already-run)
 * KYC/AML hook verdicts into KYC_AML findings.
 *
 * Rule findings carry HIGH confidence: a sanctions/ban hit is a categorical match,
 * not an inference. Confidence is graded by check type — an exact sanctioned-
 * country code or a tenant's own blacklist is near-certain; a fuzzy party-name
 * match carries a touch more false-positive risk, so it scores a little lower.
 */

const rules = require('../compliance/rules');
const { CHECK, HOOK_STATUS } = require('../compliance/schema');
const {
    finding, reasoningStep, SOURCE, RISK_CATEGORY, SEVERITY,
} = require('./schema');

// Prompt 8 CHECK → agent RISK_CATEGORY.
const CHECK_TO_CATEGORY = Object.freeze({
    [CHECK.SANCTIONED_COUNTRY]: RISK_CATEGORY.SANCTIONED_COUNTRY,
    [CHECK.SANCTIONED_PARTY]: RISK_CATEGORY.SANCTIONED_PARTY,
    [CHECK.RESTRICTED_GOODS]: RISK_CATEGORY.RESTRICTED_GOODS,
    [CHECK.DUAL_USE_GOODS]: RISK_CATEGORY.DUAL_USE_GOODS,
    [CHECK.PROHIBITED_GOODS]: RISK_CATEGORY.PROHIBITED_GOODS,
    [CHECK.TRADE_BAN]: RISK_CATEGORY.TRADE_BAN,
    [CHECK.BLACKLIST]: RISK_CATEGORY.BLACKLIST,
});

// Per-check base confidence (0..100) for a rule match. A categorical match is
// near-certain; name-fuzzy / keyword matches leave more room for a false positive.
const CHECK_CONFIDENCE = Object.freeze({
    [CHECK.BLACKLIST]: 99,          // the tenant's OWN explicit deny
    [CHECK.SANCTIONED_COUNTRY]: 96, // exact ISO-2 country match
    [CHECK.PROHIBITED_GOODS]: 94,
    [CHECK.TRADE_BAN]: 92,
    [CHECK.SANCTIONED_PARTY]: 86,   // fuzzy name match — slightly less certain
    [CHECK.DUAL_USE_GOODS]: 84,
    [CHECK.RESTRICTED_GOODS]: 84,
});

/** A short action line per category. */
function recommendationFor(category) {
    switch (category) {
        case RISK_CATEGORY.PROHIBITED_GOODS:
        case RISK_CATEGORY.SANCTIONED_PARTY:
        case RISK_CATEGORY.BLACKLIST:
            return 'Hard stop — escalate to the compliance team; do not proceed.';
        case RISK_CATEGORY.SANCTIONED_COUNTRY:
        case RISK_CATEGORY.TRADE_BAN:
            return 'Verify against the live sanctions/embargo program before proceeding.';
        case RISK_CATEGORY.RESTRICTED_GOODS:
        case RISK_CATEGORY.DUAL_USE_GOODS:
            return 'Confirm export licence / end-use documentation is in place.';
        default:
            return 'Compliance review required.';
    }
}

/** Map one Prompt 8 violation → an agent finding (skips whitelisted/none). */
function violationToFinding(v) {
    if (v.whitelisted || v.severity === SEVERITY.NONE) return null;
    const category = CHECK_TO_CATEGORY[v.check];
    if (!category) return null;
    // Fuzzy-matched goods/parties lose a few points vs. a clean HS-prefix match.
    let confidence = CHECK_CONFIDENCE[v.check] ?? 80;
    if (v.details && v.details.matched_on === 'keyword') confidence -= 6;
    return finding({
        category,
        source: SOURCE.RULE,
        severity: v.severity,
        confidence,
        title: `${category.replace(/_/g, ' ')} match`,
        subject: v.subject,
        rationale: v.message,
        evidence: [`rule:${v.code}`].concat(
            v.details && v.details.list_source ? [`list:${v.details.list_source}`] : [],
            v.details && v.details.program ? [`program:${v.details.program}`] : [],
        ),
        recommendation: recommendationFor(category),
        refs: { rule_check: v.check, rule_code: v.code, details: v.details || {} },
    });
}

/** A KYC/AML hook verdict → an agent finding (only when not passed/clean). */
function hookToFinding(kind, hook) {
    if (!hook || hook.status === HOOK_STATUS.PASSED || hook.status === HOOK_STATUS.NOT_CHECKED) return null;
    const failed = hook.status === HOOK_STATUS.FAILED;
    const severity = failed ? SEVERITY.HIGH : SEVERITY.MEDIUM;
    // The hook reports its own 0..100 risk score; our confidence in the verdict is
    // high (the provider ran), so confidence tracks how decisive the status is.
    const confidence = failed ? 88 : 70;
    return finding({
        category: RISK_CATEGORY.KYC_AML,
        source: SOURCE.RULE,
        severity,
        confidence,
        title: `${kind.toUpperCase()} ${hook.status}`,
        subject: kind,
        rationale: (hook.reasons && hook.reasons.length)
            ? `${kind.toUpperCase()} hook returned '${hook.status}': ${hook.reasons.join('; ')}`
            : `${kind.toUpperCase()} hook returned '${hook.status}'`,
        evidence: (hook.reasons || []).slice(0, 6),
        recommendation: failed ? 'Resolve the failed identity/AML check before proceeding.' : 'Review the flagged identity/AML signals.',
        refs: { hook: kind, status: hook.status, score: hook.score ?? null },
    });
}

/**
 * Run the rule layer.
 *
 * @param {object} input
 * @param {object} input.subject     normalized screening subject (from signals.scan)
 * @param {object} input.refData     { sanctionedCountries, namedParties, controlledGoods, tradeBans }
 * @param {object} [input.tenantLists] { blacklist, whitelist }
 * @param {object} [input.hooks]     { provider, kyc, aml } from kycAml.screen (run by the orchestrator)
 * @returns {{ findings, checks, steps }}
 */
function analyze({ subject, refData, tenantLists = {}, hooks = null } = {}) {
    const { violations, checks } = rules.run(subject, refData || {}, tenantLists);

    const findings = [];
    for (const v of violations) {
        const f = violationToFinding(v);
        if (f) findings.push(f);
    }
    if (hooks) {
        const kyc = hookToFinding('kyc', hooks.kyc);
        const aml = hookToFinding('aml', hooks.aml);
        if (kyc) findings.push(kyc);
        if (aml) findings.push(aml);
    }

    const ruleHits = findings.filter((f) => f.category !== RISK_CATEGORY.KYC_AML).length;
    const steps = [
        reasoningStep({
            step: 0,
            phase: 'rule',
            summary: `Rule layer ran ${Object.keys(checks).length} deterministic checks; ${ruleHits} sanctions/control violation(s) found.`,
            detail: 'Reused the Prompt 8 Compliance & Sanctions rules engine (sanctioned countries/parties, controlled goods, trade bans, tenant blacklist).',
            finding_ids: findings.filter((f) => f.category !== RISK_CATEGORY.KYC_AML).map((f) => f.id),
        }),
    ];
    if (hooks) {
        steps.push(reasoningStep({
            step: 0,
            phase: 'rule',
            summary: `KYC '${hooks.kyc ? hooks.kyc.status : 'n/a'}' / AML '${hooks.aml ? hooks.aml.status : 'n/a'}' (provider: ${hooks.provider}).`,
            finding_ids: findings.filter((f) => f.category === RISK_CATEGORY.KYC_AML).map((f) => f.id),
        }));
    }

    return { findings, checks, steps };
}

module.exports = {
    analyze,
    violationToFinding,
    hookToFinding,
    recommendationFor,
    CHECK_TO_CATEGORY,
    CHECK_CONFIDENCE,
};
