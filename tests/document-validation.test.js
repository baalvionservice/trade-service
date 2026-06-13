'use strict';
// AI Document Validation Engine — tests (Prompt 5).
//
// PURE suites only (no DB): normalizers, the six rules-engine checks, the
// pluggable AI classification layer, the report builder (status / confidence /
// readiness impact), and the stateless validatePayload pipeline. Everything here
// is deterministic — the clock is injected and the default AI provider is the
// network-free heuristic.
//
// NOTE: jest is currently broken repo-wide (jest-runtime clearMocksOnScope
// version skew). A standalone runner — `node tests/document-validation.verify.js`
// — executes these same assertions today; this file is the jest mirror for when
// the runner is repaired.

const norm = require('../service/validation/normalize');
const rules = require('../service/validation/rules');
const ai = require('../service/validation/aiClassifier');
const report = require('../service/validation/report');
const engine = require('../service/validation/validationEngine');
const { SEVERITY, CODE, STATUS } = require('../service/validation/schema');

const NOW = new Date('2026-06-11T00:00:00Z');

// ───────────────────────────────────────────────────────────────────────────
// 1. NORMALIZERS
// ───────────────────────────────────────────────────────────────────────────
describe('normalize', () => {
    test('toNumber handles US and EU grouping', () => {
        expect(norm.toNumber('1,234.50')).toBe(1234.5);
        expect(norm.toNumber('1.234,50')).toBe(1234.5);
        expect(norm.toNumber('$ 1 000')).toBe(1000);
        expect(norm.toNumber('abc')).toBeNull();
    });
    test('toCurrency resolves symbols, aliases and ISO codes', () => {
        expect(norm.toCurrency('$')).toBe('USD');
        expect(norm.toCurrency('US$')).toBe('USD');
        expect(norm.toCurrency('Euros')).toBe('EUR');
        expect(norm.toCurrency('inr')).toBe('INR');
        expect(norm.toCurrency('???')).toBeNull();
    });
    test('toGrams normalizes weight units to a base unit', () => {
        expect(norm.toGrams('1 tonne')).toBe(1_000_000);
        expect(norm.toGrams({ value: 1, unit: 'kg' })).toBe(1000);
        expect(norm.toGrams('2 lb')).toBeCloseTo(907.18474, 3);
        expect(norm.toGrams('weird')).toBeNull();
    });
    test('addressSimilarity is high for abbreviation variants, low for different', () => {
        expect(norm.addressSimilarity('12 Main St', '12 Main Street')).toBeGreaterThanOrEqual(0.99);
        expect(norm.addressSimilarity('12 Main St, NYC', '99 Other Rd, Berlin')).toBeLessThan(0.3);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. RULES ENGINE — the six checks
// ───────────────────────────────────────────────────────────────────────────
describe('rules.run — field consistency checks', () => {
    test('a matching document yields no mismatch findings', () => {
        const extracted = { invoice_number: 'INV-1', currency: 'USD', quantity: 100, unit_price: 5, total_amount: 500, tax_amount: 90, seller: 'A', buyer: 'B' };
        const expected = { currency: 'USD', quantity: 100, total_amount: 500, tax_amount: 90 };
        const { findings } = rules.run({ extracted, expected, docType: 'commercial_invoice' });
        expect(findings).toHaveLength(0);
    });
    test('quantity mismatch flagged HIGH', () => {
        const { findings } = rules.run({ extracted: { quantity: 90 }, expected: { quantity: 100 } });
        const f = findings.find((x) => x.code === CODE.QUANTITY_MISMATCH);
        expect(f).toBeDefined();
        expect(f.severity).toBe(SEVERITY.HIGH);
        expect(f.delta).toBe(10);
    });
    test('weight mismatch normalizes units before comparing', () => {
        const { findings } = rules.run({ extracted: { gross_weight: '1200 kg' }, expected: { gross_weight: '1 tonne' } });
        expect(findings.some((x) => x.code === CODE.WEIGHT_MISMATCH && x.field === 'gross_weight')).toBe(true);
    });
    test('weight within 1% tolerance passes', () => {
        const { findings } = rules.run({ extracted: { gross_weight: '1005 kg' }, expected: { gross_weight: '1000 kg' } });
        expect(findings.some((x) => x.code === CODE.WEIGHT_MISMATCH)).toBe(false);
    });
    test('currency mismatch flagged CRITICAL', () => {
        const { findings } = rules.run({ extracted: { currency: 'EUR' }, expected: { currency: 'USD' } });
        const f = findings.find((x) => x.code === CODE.CURRENCY_MISMATCH);
        expect(f.severity).toBe(SEVERITY.CRITICAL);
    });
    test('address mismatch flagged when similarity is low', () => {
        const { findings } = rules.run({
            extracted: { consignee_address: '99 Other Rd, Berlin' },
            expected: { consignee_address: '12 Main Street, New York' },
        });
        expect(findings.some((x) => x.code === CODE.ADDRESS_MISMATCH)).toBe(true);
    });
    test('tax mismatch: stated vs expected AND arithmetic consistency', () => {
        const { findings } = rules.run({
            extracted: { tax_amount: 50, tax_rate: 18, taxable_amount: 500 },
            expected: { tax_amount: 90 },
        });
        const taxFindings = findings.filter((x) => x.code === CODE.TAX_MISMATCH);
        expect(taxFindings.length).toBe(2); // vs-expected + arithmetic
    });
    test('missing required fields detected per doc type', () => {
        const { findings } = rules.run({ extracted: {}, docType: 'commercial_invoice' });
        const missing = findings.filter((x) => x.code === CODE.MISSING_FIELD).map((x) => x.field);
        expect(missing).toEqual(expect.arrayContaining(['invoice_number', 'currency', 'total_amount']));
    });
    test('absent values are not mismatches — only completeness concerns', () => {
        const { findings } = rules.run({ extracted: { currency: 'USD' }, expected: { quantity: 100 } });
        expect(findings.some((x) => x.code === CODE.QUANTITY_MISMATCH)).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. AI CLASSIFICATION LAYER — pluggable
// ───────────────────────────────────────────────────────────────────────────
describe('aiClassifier', () => {
    afterEach(() => ai.resetProvider());

    test('heuristic provider classifies an invoice from its fields', async () => {
        const r = await ai.classify({
            document: { doc_type: 'commercial_invoice', title: 'Commercial Invoice' },
            extracted: { invoice_number: 'INV-1', unit_price: 5, total_amount: 500, currency: 'USD' },
        });
        expect(r.docType).toBe('commercial_invoice');
        expect(r.provider).toBe('heuristic');
    });
    test('declared-vs-inferred mismatch is flagged', async () => {
        const r = await ai.classify({
            document: { doc_type: 'bill_of_lading', title: 'Commercial Invoice' },
            extracted: { invoice_number: 'INV-1', unit_price: 5, total_amount: 500, currency: 'USD' },
        });
        expect(r.findings.some((f) => f.code === CODE.DOC_TYPE_MISMATCH)).toBe(true);
    });
    test('implausible values surface as AI findings', async () => {
        const r = await ai.classify({
            document: { doc_type: 'packing_list' },
            extracted: { quantity: -5, gross_weight: '100 kg', net_weight: '200 kg' },
        });
        expect(r.findings.some((f) => f.code === CODE.IMPLAUSIBLE_VALUE && f.field === 'quantity')).toBe(true);
        expect(r.findings.some((f) => f.code === CODE.IMPLAUSIBLE_VALUE && f.field === 'net_weight')).toBe(true);
    });
    test('a custom provider can be registered (pluggable seam)', async () => {
        ai.registerProvider({
            name: 'stub-llm',
            async classify() { return { docType: 'certificate_of_origin', confidence: 99, findings: [] }; },
        });
        const r = await ai.classify({ document: {}, extracted: {} });
        expect(r.provider).toBe('stub-llm');
        expect(r.docType).toBe('certificate_of_origin');
    });
    test('a throwing provider degrades gracefully, never crashes', async () => {
        ai.registerProvider({ name: 'bad', async classify() { throw new Error('boom'); } });
        const r = await ai.classify({ document: {}, extracted: {} });
        expect(r.degraded).toBe(true);
        expect(r.findings).toHaveLength(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. REPORT BUILDER — status / confidence / readiness impact
// ───────────────────────────────────────────────────────────────────────────
describe('report.build', () => {
    test('no findings → passed, readiness 100, not blocking', () => {
        const r = report.build({ ruleFindings: [], classification: { docType: 'x', confidence: 90, findings: [] }, now: NOW });
        expect(r.status).toBe(STATUS.PASSED);
        expect(r.readiness_impact.score).toBe(100);
        expect(r.readiness_impact.blocking).toBe(false);
    });
    test('a CRITICAL finding → failed, readiness 0, blocking', () => {
        const { findings } = rules.run({ extracted: { currency: 'EUR' }, expected: { currency: 'USD' } });
        const r = report.build({ ruleFindings: findings, now: NOW });
        expect(r.status).toBe(STATUS.FAILED);
        expect(r.readiness_impact.score).toBe(0);
        expect(r.readiness_impact.blocking).toBe(true);
    });
    test('only a MEDIUM finding → passed_with_warnings', () => {
        const { findings } = rules.run({ extracted: {}, docType: 'commercial_invoice' }); // missing fields = medium
        const r = report.build({ ruleFindings: findings, now: NOW });
        expect(r.status).toBe(STATUS.PASSED_WITH_WARNINGS);
    });
    test('findings are sorted worst-first and counted by dimension', () => {
        const { findings } = rules.run({
            extracted: { currency: 'EUR', quantity: 90 },
            expected: { currency: 'USD', quantity: 100 },
        });
        const r = report.build({ ruleFindings: findings, now: NOW });
        expect(r.findings[0].severity).toBe(SEVERITY.CRITICAL);
        expect(r.summary.by_severity.critical).toBe(1);
        expect(r.summary.by_severity.high).toBe(1);
    });
    test('report is deterministic for a fixed clock', () => {
        const a = report.build({ ruleFindings: [], now: NOW });
        const b = report.build({ ruleFindings: [], now: NOW });
        expect(a.generated_at).toBe(b.generated_at);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. STATELESS PIPELINE — engine.validatePayload
// ───────────────────────────────────────────────────────────────────────────
describe('engine.validatePayload', () => {
    test('clean invoice passes end-to-end', async () => {
        const r = await engine.validatePayload({
            document: { doc_type: 'commercial_invoice', title: 'Commercial Invoice' },
            extracted: { invoice_number: 'INV-1', currency: 'USD', quantity: 100, unit_price: 5, total_amount: 500, tax_amount: 90, tax_rate: 18, taxable_amount: 500, seller: 'A', buyer: 'B', gross_weight: '1000 kg' },
            expected: { currency: 'USD', quantity: 100, total_amount: 500, tax_amount: 90, gross_weight: '1 tonne' },
            now: NOW,
        });
        expect(r.status).toBe(STATUS.PASSED);
        expect(r.summary.total).toBe(0);
        expect(r.readiness_impact.score).toBe(100);
    });
    test('fully-divergent invoice fails with all six categories represented', async () => {
        const r = await engine.validatePayload({
            document: { doc_type: 'commercial_invoice', title: 'Commercial Invoice' },
            extracted: { invoice_number: 'INV-2', currency: 'EUR', quantity: 90, unit_price: 5, total_amount: 500, tax_amount: 50, tax_rate: 18, taxable_amount: 500, seller: 'A', consignee_address: '99 Other Rd, Berlin', gross_weight: '1200 kg' },
            expected: { currency: 'USD', quantity: 100, total_amount: 500, tax_amount: 90, gross_weight: '1 tonne', consignee_address: '12 Main Street, New York' },
            now: NOW,
        });
        expect(r.status).toBe(STATUS.FAILED);
        const cats = new Set(r.findings.map((f) => f.category));
        for (const c of ['quantity', 'weight', 'address', 'currency', 'tax', 'completeness']) {
            expect(cats.has(c)).toBe(true);
        }
        expect(r.readiness_impact.blocking).toBe(true);
    });
});
