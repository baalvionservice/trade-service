'use strict';
/**
 * AI Document Validation Engine — standalone verification harness (Prompt 5).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script
 * runs the same PURE assertions as document-validation.test.js using a tiny
 * built-in runner. No DB, no network — deterministic.
 *
 *   node tests/document-validation.verify.js
 */
const assert = require('assert');
const norm = require('../service/validation/normalize');
const rules = require('../service/validation/rules');
const ai = require('../service/validation/aiClassifier');
const report = require('../service/validation/report');
const engine = require('../service/validation/validationEngine');
const { SEVERITY, CODE, STATUS } = require('../service/validation/schema');

const NOW = new Date('2026-06-11T00:00:00Z');
let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
    try {
        await fn();
        pass += 1;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail += 1;
        failures.push({ name, message: err.message });
        console.log(`  ✗ ${name}\n      ${err.message}`);
    }
}
function section(title) { console.log(`\n${title}`); }

(async () => {
    // ── normalizers ──────────────────────────────────────────────────────────
    section('normalize');
    await t('toNumber US/EU grouping', () => {
        assert.strictEqual(norm.toNumber('1,234.50'), 1234.5);
        assert.strictEqual(norm.toNumber('1.234,50'), 1234.5);
        assert.strictEqual(norm.toNumber('$ 1 000'), 1000);
        assert.strictEqual(norm.toNumber('abc'), null);
    });
    await t('toCurrency symbols/aliases/ISO', () => {
        assert.strictEqual(norm.toCurrency('$'), 'USD');
        assert.strictEqual(norm.toCurrency('US$'), 'USD');
        assert.strictEqual(norm.toCurrency('Euros'), 'EUR');
        assert.strictEqual(norm.toCurrency('inr'), 'INR');
        assert.strictEqual(norm.toCurrency('???'), null);
    });
    await t('toGrams unit normalization', () => {
        assert.strictEqual(norm.toGrams('1 tonne'), 1_000_000);
        assert.strictEqual(norm.toGrams({ value: 1, unit: 'kg' }), 1000);
        assert.ok(Math.abs(norm.toGrams('2 lb') - 907.18474) < 0.001);
        assert.strictEqual(norm.toGrams('weird'), null);
    });
    await t('addressSimilarity abbrev vs different', () => {
        assert.ok(norm.addressSimilarity('12 Main St', '12 Main Street') >= 0.99);
        assert.ok(norm.addressSimilarity('12 Main St, NYC', '99 Other Rd, Berlin') < 0.3);
    });

    // ── rules engine ─────────────────────────────────────────────────────────
    section('rules.run — six checks');
    await t('matching document → no mismatch findings', () => {
        const { findings } = rules.run({
            extracted: { invoice_number: 'INV-1', currency: 'USD', quantity: 100, unit_price: 5, total_amount: 500, tax_amount: 90, seller: 'A', buyer: 'B' },
            expected: { currency: 'USD', quantity: 100, total_amount: 500, tax_amount: 90 },
            docType: 'commercial_invoice',
        });
        assert.strictEqual(findings.length, 0);
    });
    await t('quantity mismatch HIGH with delta', () => {
        const { findings } = rules.run({ extracted: { quantity: 90 }, expected: { quantity: 100 } });
        const f = findings.find((x) => x.code === CODE.QUANTITY_MISMATCH);
        assert.ok(f && f.severity === SEVERITY.HIGH && f.delta === 10);
    });
    await t('weight mismatch normalizes units', () => {
        const { findings } = rules.run({ extracted: { gross_weight: '1200 kg' }, expected: { gross_weight: '1 tonne' } });
        assert.ok(findings.some((x) => x.code === CODE.WEIGHT_MISMATCH && x.field === 'gross_weight'));
    });
    await t('weight within 1% tolerance passes', () => {
        const { findings } = rules.run({ extracted: { gross_weight: '1005 kg' }, expected: { gross_weight: '1000 kg' } });
        assert.ok(!findings.some((x) => x.code === CODE.WEIGHT_MISMATCH));
    });
    await t('currency mismatch CRITICAL', () => {
        const { findings } = rules.run({ extracted: { currency: 'EUR' }, expected: { currency: 'USD' } });
        assert.strictEqual(findings.find((x) => x.code === CODE.CURRENCY_MISMATCH).severity, SEVERITY.CRITICAL);
    });
    await t('address mismatch on low similarity', () => {
        const { findings } = rules.run({
            extracted: { consignee_address: '99 Other Rd, Berlin' },
            expected: { consignee_address: '12 Main Street, New York' },
        });
        assert.ok(findings.some((x) => x.code === CODE.ADDRESS_MISMATCH));
    });
    await t('tax mismatch: vs-expected + arithmetic', () => {
        const { findings } = rules.run({
            extracted: { tax_amount: 50, tax_rate: 18, taxable_amount: 500 },
            expected: { tax_amount: 90 },
        });
        assert.strictEqual(findings.filter((x) => x.code === CODE.TAX_MISMATCH).length, 2);
    });
    await t('missing required fields per doc type', () => {
        const { findings } = rules.run({ extracted: {}, docType: 'commercial_invoice' });
        const missing = findings.filter((x) => x.code === CODE.MISSING_FIELD).map((x) => x.field);
        ['invoice_number', 'currency', 'total_amount'].forEach((f) => assert.ok(missing.includes(f), `missing ${f}`));
    });
    await t('absent value is not a mismatch', () => {
        const { findings } = rules.run({ extracted: { currency: 'USD' }, expected: { quantity: 100 } });
        assert.ok(!findings.some((x) => x.code === CODE.QUANTITY_MISMATCH));
    });

    // ── AI classification layer ──────────────────────────────────────────────
    section('aiClassifier — pluggable');
    await t('heuristic classifies invoice', async () => {
        const r = await ai.classify({ document: { doc_type: 'commercial_invoice', title: 'Commercial Invoice' }, extracted: { invoice_number: 'INV-1', unit_price: 5, total_amount: 500, currency: 'USD' } });
        assert.strictEqual(r.docType, 'commercial_invoice');
        assert.strictEqual(r.provider, 'heuristic');
    });
    await t('declared-vs-inferred mismatch flagged', async () => {
        const r = await ai.classify({ document: { doc_type: 'bill_of_lading', title: 'Commercial Invoice' }, extracted: { invoice_number: 'INV-1', unit_price: 5, total_amount: 500, currency: 'USD' } });
        assert.ok(r.findings.some((f) => f.code === CODE.DOC_TYPE_MISMATCH));
    });
    await t('implausible values → AI findings', async () => {
        const r = await ai.classify({ document: { doc_type: 'packing_list' }, extracted: { quantity: -5, gross_weight: '100 kg', net_weight: '200 kg' } });
        assert.ok(r.findings.some((f) => f.code === CODE.IMPLAUSIBLE_VALUE && f.field === 'quantity'));
        assert.ok(r.findings.some((f) => f.code === CODE.IMPLAUSIBLE_VALUE && f.field === 'net_weight'));
    });
    await t('custom provider can be registered', async () => {
        ai.registerProvider({ name: 'stub-llm', async classify() { return { docType: 'certificate_of_origin', confidence: 99, findings: [] }; } });
        const r = await ai.classify({ document: {}, extracted: {} });
        assert.strictEqual(r.provider, 'stub-llm');
        assert.strictEqual(r.docType, 'certificate_of_origin');
        ai.resetProvider();
    });
    await t('throwing provider degrades gracefully', async () => {
        ai.registerProvider({ name: 'bad', async classify() { throw new Error('boom'); } });
        const r = await ai.classify({ document: {}, extracted: {} });
        assert.strictEqual(r.degraded, true);
        assert.strictEqual(r.findings.length, 1);
        ai.resetProvider();
    });

    // ── report builder ───────────────────────────────────────────────────────
    section('report.build — status / confidence / readiness');
    await t('no findings → passed, readiness 100', () => {
        const r = report.build({ ruleFindings: [], classification: { docType: 'x', confidence: 90, findings: [] }, now: NOW });
        assert.strictEqual(r.status, STATUS.PASSED);
        assert.strictEqual(r.readiness_impact.score, 100);
        assert.strictEqual(r.readiness_impact.blocking, false);
    });
    await t('CRITICAL → failed, readiness 0, blocking', () => {
        const { findings } = rules.run({ extracted: { currency: 'EUR' }, expected: { currency: 'USD' } });
        const r = report.build({ ruleFindings: findings, now: NOW });
        assert.strictEqual(r.status, STATUS.FAILED);
        assert.strictEqual(r.readiness_impact.score, 0);
        assert.strictEqual(r.readiness_impact.blocking, true);
    });
    await t('MEDIUM-only → passed_with_warnings', () => {
        const { findings } = rules.run({ extracted: {}, docType: 'commercial_invoice' });
        const r = report.build({ ruleFindings: findings, now: NOW });
        assert.strictEqual(r.status, STATUS.PASSED_WITH_WARNINGS);
    });
    await t('worst-first sorting + per-dimension counts', () => {
        const { findings } = rules.run({ extracted: { currency: 'EUR', quantity: 90 }, expected: { currency: 'USD', quantity: 100 } });
        const r = report.build({ ruleFindings: findings, now: NOW });
        assert.strictEqual(r.findings[0].severity, SEVERITY.CRITICAL);
        assert.strictEqual(r.summary.by_severity.critical, 1);
        assert.strictEqual(r.summary.by_severity.high, 1);
    });
    await t('deterministic generated_at for fixed clock', () => {
        const a = report.build({ ruleFindings: [], now: NOW });
        const b = report.build({ ruleFindings: [], now: NOW });
        assert.strictEqual(a.generated_at, b.generated_at);
    });

    // ── stateless pipeline ───────────────────────────────────────────────────
    section('engine.validatePayload — end-to-end');
    await t('clean invoice passes', async () => {
        const r = await engine.validatePayload({
            document: { doc_type: 'commercial_invoice', title: 'Commercial Invoice' },
            extracted: { invoice_number: 'INV-1', currency: 'USD', quantity: 100, unit_price: 5, total_amount: 500, tax_amount: 90, tax_rate: 18, taxable_amount: 500, seller: 'A', buyer: 'B', gross_weight: '1000 kg' },
            expected: { currency: 'USD', quantity: 100, total_amount: 500, tax_amount: 90, gross_weight: '1 tonne' },
            now: NOW,
        });
        assert.strictEqual(r.status, STATUS.PASSED);
        assert.strictEqual(r.summary.total, 0);
        assert.strictEqual(r.readiness_impact.score, 100);
    });
    await t('divergent invoice fails with all six categories', async () => {
        const r = await engine.validatePayload({
            document: { doc_type: 'commercial_invoice', title: 'Commercial Invoice' },
            extracted: { invoice_number: 'INV-2', currency: 'EUR', quantity: 90, unit_price: 5, total_amount: 500, tax_amount: 50, tax_rate: 18, taxable_amount: 500, seller: 'A', consignee_address: '99 Other Rd, Berlin', gross_weight: '1200 kg' },
            expected: { currency: 'USD', quantity: 100, total_amount: 500, tax_amount: 90, gross_weight: '1 tonne', consignee_address: '12 Main Street, New York' },
            now: NOW,
        });
        assert.strictEqual(r.status, STATUS.FAILED);
        const cats = new Set(r.findings.map((f) => f.category));
        ['quantity', 'weight', 'address', 'currency', 'tax', 'completeness'].forEach((c) => assert.ok(cats.has(c), `category ${c} missing`));
        assert.strictEqual(r.readiness_impact.blocking, true);
    });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`document-validation: ${pass} passed, ${fail} failed`);
    if (fail > 0) {
        console.log('\nFAILURES:');
        failures.forEach((f) => console.log(`  • ${f.name}: ${f.message}`));
        process.exit(1);
    }
    process.exit(0);
})().catch((err) => { console.error('HARNESS ERROR', err); process.exit(1); });
