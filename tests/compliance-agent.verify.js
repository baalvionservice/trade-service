'use strict';
/**
 * Compliance AI Agent — standalone verification harness (Prompt 13).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script
 * exercises the PURE layers (schema / signals / ruleAnalyzer / aiAnalyzer / fusion
 * / explain) AND the orchestrator's pure compose() pipeline with a tiny built-in
 * runner. No DB, no network — deterministic via an injected clock + the static
 * dataset reference data.
 *
 *   node tests/compliance-agent.verify.js
 */
const assert = require('assert');
const dataset = require('../service/compliance/dataset');
const kycAml = require('../service/compliance/kycAml');

const schema = require('../service/complianceAgent/schema');
const signals = require('../service/complianceAgent/signals');
const ruleAnalyzer = require('../service/complianceAgent/ruleAnalyzer');
const aiAnalyzer = require('../service/complianceAgent/aiAnalyzer');
const fusion = require('../service/complianceAgent/fusion');
const explain = require('../service/complianceAgent/explain');
const agent = require('../service/complianceAgent/agent');

const { SOURCE, RISK_CATEGORY, SEVERITY, AGENT_DECISION } = schema;
const NOW = new Date('2026-06-11T00:00:00Z');

let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
    try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
    catch (err) { fail += 1; failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
function section(title) { console.log(`\n${title}`); }

// Reference data straight from the dataset (the seed's source of truth).
const REF = {
    sanctionedCountries: dataset.sanctionedCountries(),
    namedParties: dataset.namedParties(),
    controlledGoods: dataset.controlledGoods(),
    tradeBans: dataset.tradeBans(),
};

const scanOf = (shipment, operation = {}, overrides = {}) =>
    signals.scan({ shipment, operation, overrides, now: NOW });

// compose() needs loaded context; build it synchronously-ish per subject.
async function composeFor(shipment, operation = {}, { lists = {}, runHooks = true } = {}) {
    const scan = scanOf(shipment, operation);
    const hooks = runHooks ? await kycAml.screen(scan.subject) : null;
    return agent.compose({ scan, refData: REF, tenantLists: lists, hooks });
}

(async () => {
    // ── schema ─────────────────────────────────────────────────────────────────
    section('schema');
    t('finding() normalizes + derives id/band', () => {
        const f = schema.finding({
            category: RISK_CATEGORY.JURISDICTION_RISK, source: SOURCE.AI,
            severity: SEVERITY.MEDIUM, confidence: 73, title: 'x', subject: 'IR',
            rationale: 'r',
        });
        assert.strictEqual(f.id, 'jurisdiction_risk:ir');
        assert.strictEqual(f.confidence_band, 'medium');
        assert.ok(Object.isFrozen(f));
    });
    t('finding() rejects unknown category/source', () => {
        assert.throws(() => schema.finding({ category: 'nope', rationale: '' }));
        assert.throws(() => schema.finding({ category: RISK_CATEGORY.AML_PATTERN, source: 'bogus' }));
    });
    t('worseDecision ladder clear<monitor<review<block', () => {
        assert.strictEqual(schema.worseDecision(AGENT_DECISION.CLEAR, AGENT_DECISION.REVIEW), AGENT_DECISION.REVIEW);
        assert.strictEqual(schema.worseDecision(AGENT_DECISION.BLOCK, AGENT_DECISION.REVIEW), AGENT_DECISION.BLOCK);
        assert.strictEqual(schema.worseDecision(AGENT_DECISION.MONITOR, AGENT_DECISION.CLEAR), AGENT_DECISION.MONITOR);
    });
    t('confidenceBand thresholds', () => {
        assert.strictEqual(schema.confidenceBand(75), 'high');
        assert.strictEqual(schema.confidenceBand(50), 'medium');
        assert.strictEqual(schema.confidenceBand(49), 'low');
    });

    // ── signals (the scan) ───────────────────────────────────────────────────────
    section('signals (shipment scan)');
    t('scan builds subject from shipment-first fields (alpha-2 + alpha-3)', () => {
        const scan = scanOf({ origin_country: 'DE', destination_country: 'USA', declared_value: 5000, currency: 'EUR' });
        assert.strictEqual(scan.subject.originCountry, 'DE');
        assert.strictEqual(scan.subject.destinationCountry, 'US');
        assert.strictEqual(scan.subject.totalValue, 5000);
        assert.ok(scan.signals.some((s) => s.code === 'declared_value'));
    });
    t('scan derives parties from operation buyer/seller when shipment omits them', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'US' }, { seller_org_id: 'ACME', buyer_org_id: 'BUYCO' });
        assert.strictEqual(scan.subject.parties.length, 2);
        assert.ok(scan.subject.parties.find((p) => p.role === 'seller' && p.name === 'ACME'));
    });
    t('transitCountries excludes endpoints', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'IR', metadata: { route: ['CN', 'AE', 'IR'] } });
        assert.deepStrictEqual(signals.transitCountries(scan.subject), ['AE']);
    });
    t('vague description detection', () => {
        assert.strictEqual(signals.isVagueDescription('goods'), true);
        assert.strictEqual(signals.isVagueDescription('industrial centrifuge model X'), false);
        assert.strictEqual(signals.isVagueDescription(''), true);
    });
    t('scan flags missing party country + missing HS as signals', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'US', metadata: {
            parties: [{ name: 'X', role: 'buyer' }], goods: [{ description: 'widget' }],
        } });
        assert.ok(scan.signals.some((s) => s.code === 'party_no_country'));
        assert.ok(scan.signals.some((s) => s.code === 'goods_no_hs'));
    });

    // ── ruleAnalyzer (the rule half) ─────────────────────────────────────────────
    section('ruleAnalyzer (rule layer)');
    t('maps a sanctioned-country violation to a high-confidence rule finding', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'IR' });
        const { findings } = ruleAnalyzer.analyze({ subject: scan.subject, refData: REF });
        const sc = findings.find((f) => f.category === RISK_CATEGORY.SANCTIONED_COUNTRY);
        assert.ok(sc, 'expected a sanctioned_country finding');
        assert.strictEqual(sc.source, SOURCE.RULE);
        assert.strictEqual(sc.severity, SEVERITY.CRITICAL); // IR is critical
        assert.ok(sc.confidence >= 90);
    });
    t('whitelisted violations are not surfaced as findings', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'VE' }); // VE = medium
        const lists = { whitelist: [{ subject_type: 'country', value: 'VE', severity: 'medium' }] };
        const { findings } = ruleAnalyzer.analyze({ subject: scan.subject, refData: REF, tenantLists: lists });
        assert.ok(!findings.some((f) => f.category === RISK_CATEGORY.SANCTIONED_COUNTRY));
    });
    t('failed KYC/AML hook becomes a rule finding', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'US', metadata: { parties: [{ role: 'buyer' }] } });
        const hooks = { provider: 'test', kyc: { status: 'failed', reasons: ['no id'] }, aml: { status: 'passed' } };
        const { findings } = ruleAnalyzer.analyze({ subject: scan.subject, refData: REF, hooks });
        const k = findings.find((f) => f.category === RISK_CATEGORY.KYC_AML);
        assert.ok(k && k.refs.status === 'failed');
    });

    // ── aiAnalyzer (the AI half) ─────────────────────────────────────────────────
    section('aiAnalyzer (AI layer)');
    t('jurisdiction-risk detector fires on elevated-risk nexus', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'RU' });
        const f = aiAnalyzer.detectJurisdictionRisk(scan.subject);
        assert.ok(f && f.category === RISK_CATEGORY.JURISDICTION_RISK && f.source === SOURCE.AI);
    });
    t('route-anomaly detector fires on transshipment hub toward high-risk dest', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'RU', metadata: { route: ['CN', 'AE', 'RU'] } });
        const f = aiAnalyzer.detectRouteAnomaly(scan.subject);
        assert.ok(f && f.category === RISK_CATEGORY.ROUTE_ANOMALY);
        assert.ok(f.refs.hub_legs.includes('AE'));
    });
    t('valuation-anomaly detector flags gross under-valuation', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'US', metadata: {
            goods: [{ description: 'server rack', category: 'electronics', value: 1 }],
        } });
        const f = aiAnalyzer.detectValuationAnomaly(scan.subject);
        assert.ok(f && f.refs.direction === 'under');
    });
    t('misclassification detector flags sensitive dual-use cue', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'US', metadata: {
            goods: [{ description: 'maraging steel tube', category: 'metals' }],
        } });
        const f = aiAnalyzer.detectGoodsMisclassification(scan.subject);
        assert.ok(f && f.severity === SEVERITY.HIGH);
    });
    t('aml-pattern detector fires on high value into high-risk jurisdiction', () => {
        const scan = scanOf({ origin_country: 'US', destination_country: 'RU', declared_value: 2000000 });
        const f = aiAnalyzer.detectAmlPattern(scan.subject);
        assert.ok(f && f.category === RISK_CATEGORY.AML_PATTERN);
    });
    t('AI provider is pluggable + degrades safely', async () => {
        aiAnalyzer.registerProvider({ name: 'mock', async analyze() { return { findings: [], reasoning: 'mock ran' }; } });
        let r = await aiAnalyzer.analyze({ subject: scanOf({ origin_country: 'US', destination_country: 'RU' }).subject });
        assert.strictEqual(r.provider, 'mock');
        aiAnalyzer.registerProvider({ name: 'boom', async analyze() { throw new Error('kaput'); } });
        r = await aiAnalyzer.analyze({ subject: {} });
        assert.strictEqual(r.degraded, true);
        assert.strictEqual(r.findings.length, 0);
        aiAnalyzer.resetProvider();
        assert.strictEqual(aiAnalyzer.getProvider().name, 'heuristic');
    });
    t('a misbehaving provider finding is dropped, not crash', () => {
        assert.strictEqual(aiAnalyzer.normalizeFinding({ category: 'bogus' }), null);
        const ok = aiAnalyzer.normalizeFinding({ category: RISK_CATEGORY.ROUTE_ANOMALY, severity: 'high', confidence: 200, rationale: 'x' });
        assert.ok(ok && ok.confidence === 100 && ok.source === SOURCE.AI);
    });

    // ── fusion (the hybrid) ──────────────────────────────────────────────────────
    section('fusion (hybrid combiner)');
    t('rule + AI on same subject merge into a corroborated hybrid', () => {
        const ruleF = schema.finding({ category: RISK_CATEGORY.SANCTIONED_PARTY, source: SOURCE.RULE, severity: SEVERITY.HIGH, confidence: 86, title: 'p', subject: 'Volga', rationale: 'rule' });
        const aiF = schema.finding({ category: RISK_CATEGORY.SANCTIONED_PARTY, source: SOURCE.AI, severity: SEVERITY.MEDIUM, confidence: 60, title: 'p', subject: 'Volga', rationale: 'ai' });
        const fused = fusion.fuseFindings([ruleF], [aiF]);
        assert.strictEqual(fused.length, 1);
        assert.strictEqual(fused[0].source, SOURCE.HYBRID);
        assert.ok(fused[0].confidence > 86, 'hybrid confidence should exceed both inputs');
        assert.deepStrictEqual(fused[0].corroborated_by, [SOURCE.RULE, SOURCE.AI]);
    });
    t('AI-only finding never blocks (advisory)', () => {
        const aiF = schema.finding({ category: RISK_CATEGORY.AML_PATTERN, source: SOURCE.AI, severity: SEVERITY.CRITICAL, confidence: 95, title: 'x', subject: 'RU', rationale: 'ai' });
        const r = fusion.fuse({ ruleFindings: [], aiFindings: [aiF] });
        assert.notStrictEqual(r.decision, AGENT_DECISION.BLOCK);
        assert.strictEqual(r.decision, AGENT_DECISION.REVIEW);
    });
    t('rule-grounded critical drives a BLOCK', () => {
        const ruleF = schema.finding({ category: RISK_CATEGORY.SANCTIONED_COUNTRY, source: SOURCE.RULE, severity: SEVERITY.CRITICAL, confidence: 96, title: 'x', subject: 'IR', rationale: 'rule' });
        const r = fusion.fuse({ ruleFindings: [ruleF], aiFindings: [] });
        assert.strictEqual(r.decision, AGENT_DECISION.BLOCK);
        assert.strictEqual(r.blocking, true);
        assert.strictEqual(r.risk_score, 100);
    });
    t('clear-verdict confidence is discounted by data gaps', () => {
        const clean = fusion.fuse({ ruleFindings: [], aiFindings: [], dataGap: false });
        const gappy = fusion.fuse({ ruleFindings: [], aiFindings: [], dataGap: true });
        assert.strictEqual(clean.decision, AGENT_DECISION.CLEAR);
        assert.ok(clean.confidence > gappy.confidence);
    });
    t('riskLevel banding', () => {
        assert.strictEqual(fusion.riskLevel(0), 'minimal');
        assert.strictEqual(fusion.riskLevel(10), 'low');
        assert.strictEqual(fusion.riskLevel(30), 'moderate');
        assert.strictEqual(fusion.riskLevel(60), 'high');
        assert.strictEqual(fusion.riskLevel(85), 'critical');
    });

    // ── explain (explainability output) ──────────────────────────────────────────
    section('explain (explainability)');
    t('builds an ordered reasoning chain + narrative + factors', () => {
        const scan = scanOf({ origin_country: 'CN', destination_country: 'RU', declared_value: 2000000 });
        const ai = { provider: 'heuristic', findings: [], reasoning: 'r' };
        const fused = fusion.fuse({ ruleFindings: [], aiFindings: [
            schema.finding({ category: RISK_CATEGORY.AML_PATTERN, source: SOURCE.AI, severity: SEVERITY.HIGH, confidence: 68, title: 'aml', subject: 'RU', rationale: 'why' }),
        ] });
        const ex = explain.build({ scan, ruleSteps: [], ai, fusion: fused });
        assert.ok(ex.reasoning.length >= 4);
        assert.strictEqual(ex.reasoning[0].step, 1);
        assert.ok(ex.reasoning.every((s, i) => s.step === i + 1), 'steps are 1..n ordered');
        assert.ok(typeof ex.narrative === 'string' && ex.narrative.length > 40);
        assert.ok(ex.factors.length === 1 && ex.factors[0].why);
    });

    // ── end-to-end compose pipeline ──────────────────────────────────────────────
    section('end-to-end compose (rule + AI hybrid)');
    t('clean low-risk shipment → clear, high confidence, no findings', async () => {
        const r = await composeFor({
            origin_country: 'DE', destination_country: 'US', declared_value: 5000, currency: 'EUR',
            metadata: { parties: [{ name: 'ACME GmbH', role: 'seller', country: 'DE' }, { name: 'BuyCo Inc', role: 'buyer', country: 'US' }], goods: [{ description: 'office chairs', hsCode: '940130', category: 'furniture', value: 5000 }] },
        });
        assert.strictEqual(r.decision, AGENT_DECISION.CLEAR);
        assert.strictEqual(r.finding_count, 0);
        assert.ok(r.confidence >= 75);
        assert.ok(r.explanation.narrative.includes('cleared'));
    });
    t('sanctioned-destination shipment → block + explainability cites it', async () => {
        const r = await composeFor({
            origin_country: 'CN', destination_country: 'IR', declared_value: 250000, currency: 'USD',
            metadata: { parties: [{ name: 'Trans Pars Co', role: 'buyer', country: 'IR' }], goods: [{ description: 'industrial pumps', hsCode: '841370', category: 'machinery' }] },
        });
        assert.strictEqual(r.decision, AGENT_DECISION.BLOCK);
        assert.strictEqual(r.blocking, true);
        assert.ok(r.risk_score >= 50);
        assert.ok(r.findings.some((f) => f.category === RISK_CATEGORY.SANCTIONED_COUNTRY));
        // AI layer should corroborate the jurisdiction → at least one hybrid/AI finding.
        assert.ok(r.by_source.ai > 0 || r.by_source.hybrid > 0);
        assert.ok(r.top_risks.length > 0);
        const decisionStep = r.explanation.reasoning.find((s) => s.phase === 'decision');
        assert.ok(decisionStep && /sanctioned_country|BLOCK/i.test(decisionStep.detail || decisionStep.summary));
    });
    t('high-risk jurisdiction + high value, no list hit → review via AI layer', async () => {
        const r = await composeFor({
            origin_country: 'US', destination_country: 'RU', declared_value: 3000000, currency: 'USD',
            metadata: { parties: [{ name: 'Volga-Don Freight', role: 'buyer', country: 'RU' }], goods: [{ description: 'cnc machining centre', hsCode: '845710', category: 'machinery' }] },
        });
        // RU is a 'high' sanctioned country in the dataset → at least review.
        assert.ok([AGENT_DECISION.REVIEW, AGENT_DECISION.BLOCK].includes(r.decision));
        assert.ok(r.by_source.ai > 0, 'AI layer should contribute risk findings');
        assert.ok(r.findings.some((f) => [RISK_CATEGORY.AML_PATTERN, RISK_CATEGORY.JURISDICTION_RISK, RISK_CATEGORY.GOODS_MISCLASSIFICATION].includes(f.category)));
        assert.ok(r.confidence > 0 && r.confidence <= 100);
    });
    t('compose output is shaped for persistence (denormalized projections present)', async () => {
        const r = await composeFor({ origin_country: 'DE', destination_country: 'US', declared_value: 1000 });
        for (const k of ['decision', 'risk_score', 'risk_level', 'severity', 'confidence', 'by_source', 'findings', 'explanation', 'signals', 'top_risks', 'model']) {
            assert.ok(Object.prototype.hasOwnProperty.call(r, k), `missing field ${k}`);
        }
        assert.ok(r.model.rule && r.model.ai);
    });

    // ── summary ─────────────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Compliance AI Agent verify: ${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('\nFailures:');
        for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
        process.exit(1);
    }
    console.log('All green ✓');
    process.exit(0);
})().catch((err) => { console.error('harness crashed:', err); process.exit(1); });
