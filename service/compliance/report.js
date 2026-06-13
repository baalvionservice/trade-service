'use strict';
/**
 * Compliance & Sanctions Engine — REPORT BUILDER (War Room 4, Prompt 8).
 *
 * PURE: no DB, no I/O. Composes the pure layers into the single
 * `compliance_report` object every caller (API response + persisted column)
 * shares:  normalize → rules.run → severity.score → assemble.
 *
 * KYC/AML hook results are passed IN (they are async — the orchestrator runs
 * kycAml.screen() and hands the verdicts here) so this module stays pure and
 * deterministic under an injected clock.
 */

const rules = require('./rules');
const severity = require('./severity');
const norm = require('./normalize');
const { HOOK_STATUS } = require('./schema');

const ENGINE_VERSION = '1.0.0';

// Hard caps on how many parties / goods a single screening considers. Bounds the
// O(parties × listed-parties) and O(goods × controlled-goods) work so an oversized
// (or malicious) payload can't turn one screen into a CPU-pressure vector. A real
// trade operation has a handful of each; these are generous ceilings, not limits.
const MAX_PARTIES = 100;
const MAX_GOODS = 100;

/**
 * Normalize raw caller input into the canonical screening subject the rules
 * engine matches on. Accepts loose shapes (single party object, bare strings).
 *
 * @param {object} raw
 *   { originCountry, destinationCountry, direction, totalValue, currency,
 *     parties: [{ name, role, country, type }], goods: [{ description, hsCode, category, value }] }
 * @returns {object} normalized subject
 */
function normalizeSubject(raw = {}) {
    const parties = [];
    const rawParties = (Array.isArray(raw.parties) ? raw.parties : (raw.party ? [raw.party] : [])).slice(0, MAX_PARTIES);
    for (const p of rawParties) {
        if (!p) continue;
        if (typeof p === 'string') { parties.push({ name: p, role: null, country: null, type: 'entity' }); continue; }
        parties.push({
            name: p.name != null ? String(p.name) : null,
            role: p.role != null ? String(p.role) : null,
            country: norm.normalizeCountry(p.country),
            type: p.type || p.party_type || 'entity',
        });
    }

    const goods = [];
    const rawGoods = (Array.isArray(raw.goods) ? raw.goods : (raw.good ? [raw.good] : [])).slice(0, MAX_GOODS);
    for (const g of rawGoods) {
        if (!g) continue;
        if (typeof g === 'string') { goods.push({ description: g, hsCode: null, category: null, value: null }); continue; }
        goods.push({
            description: g.description != null ? String(g.description) : null,
            hsCode: g.hsCode != null ? String(g.hsCode) : (g.hs_code != null ? String(g.hs_code) : null),
            category: g.category != null ? String(g.category) : null,
            value: g.value != null ? Number(g.value) : null,
        });
    }

    return {
        originCountry: norm.normalizeCountry(raw.originCountry || raw.origin_country),
        destinationCountry: norm.normalizeCountry(raw.destinationCountry || raw.destination_country),
        direction: raw.direction || 'both',
        totalValue: raw.totalValue != null ? Number(raw.totalValue) : (raw.total_value != null ? Number(raw.total_value) : null),
        currency: raw.currency || null,
        parties,
        goods,
    };
}

/** A short, human-actionable recommendation for the decision. */
function recommendationFor(decision, scoreResult) {
    if (decision === 'block') return 'Do not proceed — a hard compliance violation was found. Escalate to the compliance team.';
    if (decision === 'review') return `Manual compliance review required before proceeding (${scoreResult.actionable_count} finding(s)).`;
    return 'No compliance issues found — trade may proceed.';
}

/**
 * Build the full compliance report.
 *
 * @param {object} input
 * @param {object} input.subject       normalized subject (from normalizeSubject)
 * @param {object} input.refData       { sanctionedCountries, namedParties, controlledGoods, tradeBans }
 * @param {object} [input.tenantLists] { blacklist, whitelist }
 * @param {object} [input.hooks]       { provider, kyc:{status,...}, aml:{status,...} } from kycAml.screen
 * @param {Date|number} [input.now]
 * @returns {object} compliance_report
 */
function build({ subject, refData, tenantLists = {}, hooks = null, now = new Date() } = {}) {
    const { violations, checks } = rules.run(subject, refData, tenantLists);

    const kyc = hooks && hooks.kyc ? hooks.kyc : { status: HOOK_STATUS.NOT_CHECKED, score: 0, reasons: [] };
    const aml = hooks && hooks.aml ? hooks.aml : { status: HOOK_STATUS.NOT_CHECKED, score: 0, reasons: [] };

    const scoreResult = severity.score(violations, { kycStatus: kyc.status, amlStatus: aml.status });

    // Fold KYC/AML execution into the checks summary.
    checks.kyc = { ran: kyc.status !== HOOK_STATUS.NOT_CHECKED, status: kyc.status };
    checks.aml = { ran: aml.status !== HOOK_STATUS.NOT_CHECKED, status: aml.status };

    const screenedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

    return {
        engine_version: ENGINE_VERSION,
        screened_at: screenedAt,
        subject: {
            origin_country: subject.originCountry,
            destination_country: subject.destinationCountry,
            direction: subject.direction,
            parties: subject.parties,
            goods: subject.goods,
        },
        decision: scoreResult.decision,
        risk_score: scoreResult.risk_score,
        severity: scoreResult.severity,
        blocking: scoreResult.blocking,
        violation_count: scoreResult.actionable_count,
        violations,
        checks,
        kyc: { provider: hooks ? hooks.provider : null, ...kyc },
        aml: { provider: hooks ? hooks.provider : null, ...aml },
        summary: {
            decision: scoreResult.decision,
            risk_score: scoreResult.risk_score,
            severity: scoreResult.severity,
            actionable: scoreResult.actionable_count,
            whitelisted: scoreResult.whitelisted_count,
            counts: scoreResult.counts,
            by_check: scoreResult.by_check,
            recommendation: recommendationFor(scoreResult.decision, scoreResult),
        },
    };
}

module.exports = {
    ENGINE_VERSION,
    MAX_PARTIES,
    MAX_GOODS,
    normalizeSubject,
    recommendationFor,
    build,
};
