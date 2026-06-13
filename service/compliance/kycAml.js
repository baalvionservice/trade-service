'use strict';
/**
 * Compliance & Sanctions Engine — KYC / AML HOOKS (War Room 4, Prompt 8).
 *
 * The Know-Your-Customer and Anti-Money-Laundering checks a pure rules engine
 * can't do alone — they call out to an identity-verification / transaction-risk
 * provider. This module is the PLUGGABLE SEAM for that call.
 *
 * The default provider is a deterministic, network-free HEURISTIC so the engine
 * works offline and tests stay reproducible. A real provider — an IDV vendor
 * (Onfido/Trulioo), an AML transaction-monitoring service, or an internal risk
 * model — is dropped in with `registerProvider()` without touching the engine,
 * rules, severity or report code.
 *
 * A provider MUST implement:
 *   {
 *     name: string,
 *     async kyc({ subject, context }) => { status, score?, reasons?[] },
 *     async aml({ subject, context }) => { status, score?, reasons?[] },
 *   }
 * where status ∈ HOOK_STATUS (not_checked | pending | passed | failed | review).
 */

const { HOOK_STATUS } = require('./schema');
const norm = require('./normalize');

// AML transaction-value bands (subject.totalValue, best-effort, in any currency).
const AML_HIGH_VALUE = 1000000; // ≥ this with a risk signal → escalate
const AML_REVIEW_VALUE = 100000;

/** Countries the heuristic treats as elevated AML/KYC risk (illustrative). */
const HIGH_RISK_COUNTRIES = new Set(['IR', 'KP', 'SY', 'RU', 'BY', 'VE', 'MM', 'CU']);

function partyCountries(subject) {
    const set = new Set();
    const add = (c) => { const n = norm.normalizeCountry(c); if (n) set.add(n); };
    add(subject.originCountry);
    add(subject.destinationCountry);
    for (const p of subject.parties || []) add(p.country);
    return [...set];
}

/**
 * The default, deterministic heuristic provider. Network-free and reproducible.
 *  • KYC: every party must carry an identifiable name + country. Missing identity
 *         data → review; a complete set → passed.
 *  • AML: transaction value × counterparty-country risk. High value into a
 *         high-risk country → review (a real monitor would score the pattern).
 */
const heuristicProvider = Object.freeze({
    name: 'heuristic',

    async kyc({ subject = {} } = {}) {
        const parties = subject.parties || [];
        const reasons = [];
        if (parties.length === 0) {
            return { status: HOOK_STATUS.REVIEW, score: 50, reasons: ['no counterparties supplied for KYC'] };
        }
        let incomplete = 0;
        for (const p of parties) {
            if (norm.isBlank(p.name)) { incomplete += 1; reasons.push(`party missing name (${p.role || 'unknown role'})`); }
            else if (norm.isBlank(p.country)) { incomplete += 1; reasons.push(`party "${p.name}" missing country`); }
        }
        if (incomplete > 0) {
            return { status: HOOK_STATUS.REVIEW, score: Math.min(80, 30 + incomplete * 20), reasons };
        }
        return { status: HOOK_STATUS.PASSED, score: 5, reasons: ['all counterparties carry name + country'] };
    },

    async aml({ subject = {} } = {}) {
        const value = Number(subject.totalValue) || 0;
        const countries = partyCountries(subject);
        const highRisk = countries.filter((c) => HIGH_RISK_COUNTRIES.has(c));
        const reasons = [];
        let score = 0;

        if (highRisk.length) { score += 40; reasons.push(`high-risk jurisdiction(s): ${highRisk.join(', ')}`); }
        if (value >= AML_HIGH_VALUE) { score += 40; reasons.push(`transaction value ≥ ${AML_HIGH_VALUE}`); }
        else if (value >= AML_REVIEW_VALUE) { score += 20; reasons.push(`transaction value ≥ ${AML_REVIEW_VALUE}`); }

        let status = HOOK_STATUS.PASSED;
        if (highRisk.length && value >= AML_REVIEW_VALUE) status = HOOK_STATUS.REVIEW;
        else if (score >= 60) status = HOOK_STATUS.REVIEW;
        if (status === HOOK_STATUS.PASSED && reasons.length === 0) reasons.push('no elevated AML signals');

        return { status, score: Math.min(100, score), reasons };
    },
});

// ── Provider registry (the pluggable seam). ──────────────────────────────────
let activeProvider = heuristicProvider;

function assertProvider(p) {
    if (!p || typeof p.kyc !== 'function' || typeof p.aml !== 'function' || typeof p.name !== 'string') {
        throw new Error('registerProvider(): provider must be { name: string, kyc: async fn, aml: async fn }');
    }
}

/** Swap in a different KYC/AML provider (e.g. an IDV / transaction-monitoring vendor). */
function registerProvider(provider) {
    assertProvider(provider);
    activeProvider = provider;
    return activeProvider;
}

/** Reset to the built-in deterministic heuristic provider. */
function resetProvider() {
    activeProvider = heuristicProvider;
    return activeProvider;
}

function getProvider() {
    return activeProvider;
}

/** Defensively normalize a provider hook result so a plug-in can't crash the engine. */
function normalizeHookResult(result, kind) {
    const valid = new Set(Object.values(HOOK_STATUS));
    const status = result && valid.has(result.status) ? result.status : HOOK_STATUS.REVIEW;
    return {
        kind,
        status,
        score: Math.max(0, Math.min(100, Math.round((result && result.score) || 0))),
        reasons: Array.isArray(result && result.reasons) ? result.reasons : [],
    };
}

/**
 * Run both KYC and AML hooks via the active provider. NEVER throws — a failing
 * provider degrades to a `review` verdict (fail-safe: a hook we couldn't run is
 * not silently "passed").
 *
 * @param {object} subject  normalized screening subject (+ totalValue)
 * @param {object} [context]
 * @returns {Promise<{ provider, kyc, aml }>}
 */
async function screen(subject, context = {}) {
    const run = async (fn, kind) => {
        try {
            const r = await fn.call(activeProvider, { subject, context });
            return normalizeHookResult(r, kind);
        } catch (err) {
            return { kind, status: HOOK_STATUS.REVIEW, score: 50, reasons: [`${kind} provider '${activeProvider.name}' failed: ${err.message}`], degraded: true };
        }
    };
    const [kyc, aml] = await Promise.all([
        run(activeProvider.kyc, 'kyc'),
        run(activeProvider.aml, 'aml'),
    ]);
    return { provider: activeProvider.name, kyc, aml };
}

module.exports = {
    screen,
    registerProvider,
    resetProvider,
    getProvider,
    normalizeHookResult,
    heuristicProvider,
    HIGH_RISK_COUNTRIES,
    AML_HIGH_VALUE,
    AML_REVIEW_VALUE,
};
