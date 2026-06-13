'use strict';
/**
 * Shipment Readiness Score Engine — standalone verification harness (Prompt 6).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script
 * runs the PURE scoring assertions using a tiny built-in runner. No DB, no
 * network — fully deterministic via an injected clock.
 *
 *   node tests/shipment-readiness.verify.js
 */
const assert = require('assert');
const scoring = require('../service/readiness/scoring');

const NOW = new Date('2026-06-11T00:00:00Z');
let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
    try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
    catch (err) { fail += 1; failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
function section(title) { console.log(`\n${title}`); }

// A fully-papered, on-track, low-risk shipment fixture.
const FULL_DOCS = [
    { id: 'd1', doc_type: 'commercial_invoice', status: 'verified' },
    { id: 'd2', doc_type: 'packing_list', status: 'verified' },
    { id: 'd3', doc_type: 'bill_of_lading', status: 'verified' },
    { id: 'd4', doc_type: 'certificate_of_origin', status: 'verified' },
];
const GOOD_SHIPMENT = {
    id: 's1', tenant_id: 'T-DEMO', status: 'in_transit',
    carrier_name: 'Maersk', mode: 'sea', tracking_number: 'TRK1',
    origin_port: 'INNSA', destination_port: 'USNYC', bill_of_lading_no: 'BL1',
    estimated_arrival: '2026-06-20T00:00:00Z', declared_value: 5000,
};

(() => {
    // ── weights ────────────────────────────────────────────────────────────────
    section('model invariants');
    t('component weights sum to 100', () => {
        const sum = Object.values(scoring.WEIGHTS).reduce((a, b) => a + b, 0);
        assert.strictEqual(sum, 100);
    });
    t('bandFor thresholds', () => {
        assert.strictEqual(scoring.bandFor(80), 'high');
        assert.strictEqual(scoring.bandFor(79.99), 'medium');
        assert.strictEqual(scoring.bandFor(50), 'medium');
        assert.strictEqual(scoring.bandFor(49.99), 'low');
    });

    // ── perfect shipment ─────────────────────────────────────────────────────────
    section('compute — outputs');
    t('emits exactly the five required outputs', () => {
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', now: NOW });
        ['readiness_score', 'compliance_score', 'documentation_score', 'logistics_score', 'risk_score'].forEach((k) => {
            assert.ok(typeof r[k] === 'number', `${k} should be a number`);
            assert.ok(r[k] >= 0 && r[k] <= 100, `${k} in range`);
        });
    });
    t('fully-ready shipment scores high with no blockers', () => {
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', now: NOW });
        assert.strictEqual(r.documentation_score, 100);
        assert.strictEqual(r.logistics_score, 100);
        assert.strictEqual(r.risk_score, 100);
        assert.strictEqual(r.band, 'high');
        assert.strictEqual(r.capped, false);
        assert.strictEqual(r.blockers.length, 0);
    });
    t('readiness is the exact weighted blend of components', () => {
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', now: NOW });
        const w = scoring.WEIGHTS;
        const expected = (
            r.documentation_score / 100 * w.documentation +
            r.compliance_score / 100 * w.compliance +
            r.logistics_score / 100 * w.logistics +
            r.risk_score / 100 * w.risk
        );
        assert.ok(Math.abs(r.readiness_score - expected) < 0.05, `${r.readiness_score} ≈ ${expected}`);
    });

    // ── documentation ────────────────────────────────────────────────────────────
    section('documentation component');
    t('missing all required docs → 0 + four blockers', () => {
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: [], workflowState: 'IN_TRANSIT', now: NOW });
        assert.strictEqual(r.documentation_score, 0);
        assert.strictEqual(r.blockers.filter((b) => b.component === 'documentation').length, 4);
    });
    t('pending doc earns half credit + flags unverified', () => {
        const docs = [{ id: 'd1', doc_type: 'commercial_invoice', status: 'pending' }];
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: docs, workflowState: 'IN_TRANSIT', now: NOW });
        // 0.5 of 4 required = 12.5%
        assert.strictEqual(r.documentation_score, 12.5);
        assert.ok(r.blockers.some((b) => b.code === 'DOC_UNVERIFIED'));
    });
    t('a failed validation downgrades a verified doc', () => {
        const r = scoring.compute({
            shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT',
            validations: [{ document_ref: 'd1', status: 'failed', critical_count: 1, high_count: 0 }], now: NOW,
        });
        // d1 verified→pending (half credit): 3 + 0.5 of 4 = 87.5%
        assert.strictEqual(r.documentation_score, 87.5);
    });

    // ── compliance ────────────────────────────────────────────────────────────────
    section('compliance component');
    t('CREATED is early progress + pending blocker', () => {
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'CREATED', now: NOW });
        assert.strictEqual(r.compliance_score, 0);
        assert.ok(r.blockers.some((b) => b.code === 'COMPLIANCE_PENDING'));
    });
    t('COMPLETED is full compliance', () => {
        const r = scoring.compute({ shipment: { ...GOOD_SHIPMENT, status: 'delivered', actual_arrival: NOW }, documents: FULL_DOCS, workflowState: 'COMPLETED', now: NOW });
        assert.strictEqual(r.compliance_score, 100);
    });
    t('no workflow falls back to shipment-status mapping', () => {
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: null, now: NOW });
        assert.strictEqual(r.compliance_score, 60); // in_transit → 0.6
        assert.ok(r.blockers.some((b) => b.code === 'NO_WORKFLOW'));
    });

    // ── logistics ────────────────────────────────────────────────────────────────
    section('logistics component');
    t('incomplete logistics flags each gap', () => {
        const bare = { id: 's2', tenant_id: 'T-DEMO', status: 'booked' };
        const r = scoring.compute({ shipment: bare, documents: FULL_DOCS, workflowState: 'CREATED', now: NOW });
        assert.strictEqual(r.logistics_score, 0);
        assert.strictEqual(r.blockers.filter((b) => b.component === 'logistics').length, 6);
    });

    // ── risk ──────────────────────────────────────────────────────────────────────
    section('risk component (safety score)');
    t('critical validation slashes risk safety', () => {
        const r = scoring.compute({
            shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT',
            validations: [{ document_ref: 'd1', status: 'failed', critical_count: 1, high_count: 0 }], now: NOW,
        });
        assert.strictEqual(r.risk_score, 40); // 1 - 0.6 = 0.4
        assert.ok(r.blockers.some((b) => b.code === 'VALIDATION_CRITICAL'));
    });
    t('sanctions hold is a major risk hit', () => {
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', sanctionsHold: true, now: NOW });
        assert.strictEqual(r.risk_score, 30); // 1 - 0.7
        assert.ok(r.blockers.some((b) => b.code === 'SANCTIONS_HOLD'));
    });
    t('uninsured high value flags risk', () => {
        const r = scoring.compute({ shipment: { ...GOOD_SHIPMENT, declared_value: 250000 }, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', insured: false, now: NOW });
        assert.strictEqual(r.risk_score, 80); // 1 - 0.2
        assert.ok(r.blockers.some((b) => b.code === 'UNINSURED_HIGH_VALUE'));
    });
    t('insured high value carries no risk hit', () => {
        const r = scoring.compute({ shipment: { ...GOOD_SHIPMENT, declared_value: 250000 }, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', insured: true, now: NOW });
        assert.strictEqual(r.risk_score, 100);
    });
    t('overdue ETA scales risk over a 7-day window', () => {
        const overdue = { ...GOOD_SHIPMENT, estimated_arrival: '2026-06-04T00:00:00Z' }; // 7 days before NOW
        const r = scoring.compute({ shipment: overdue, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', now: NOW });
        assert.strictEqual(r.risk_score, 70); // full 0.3 overdue cap → 1 - 0.3
        assert.ok(r.blockers.some((b) => b.code === 'OVERDUE'));
    });

    // ── hard clamps ────────────────────────────────────────────────────────────────
    section('hard-problem clamps');
    t('cancelled shipment is clamped to <= 10', () => {
        const r = scoring.compute({ shipment: { ...GOOD_SHIPMENT, status: 'cancelled' }, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', now: NOW });
        assert.ok(r.readiness_score <= 10);
        assert.strictEqual(r.capped, true);
        assert.strictEqual(r.band, 'low');
    });
    t('FAILED workflow is clamped to <= 10', () => {
        const r = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'FAILED', workflow: { failure_reason: 'docs rejected' }, now: NOW });
        assert.ok(r.readiness_score <= 10);
        assert.strictEqual(r.capped, true);
        assert.strictEqual(r.compliance_score, 0);
    });
    t('trouble status (customs_hold) is clamped to <= 60', () => {
        const r = scoring.compute({ shipment: { ...GOOD_SHIPMENT, status: 'customs_hold' }, documents: FULL_DOCS, workflowState: 'COMPLIANCE_CHECK', now: NOW });
        assert.ok(r.readiness_score <= 60);
        assert.strictEqual(r.capped, true);
    });

    // ── determinism + guards ───────────────────────────────────────────────────────
    section('determinism + guards');
    t('identical inputs → identical scores', () => {
        const a = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', now: NOW });
        const b = scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', now: NOW });
        assert.deepStrictEqual(a, b);
    });
    t('null shipment degrades to a zeroed, capped result', () => {
        const r = scoring.compute({ shipment: null });
        assert.strictEqual(r.readiness_score, 0);
        assert.strictEqual(r.capped, true);
        assert.ok(r.blockers.some((b) => b.code === 'NOT_FOUND'));
    });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`shipment-readiness: ${pass} passed, ${fail} failed`);
    if (fail > 0) {
        console.log('\nFAILURES:');
        failures.forEach((f) => console.log(`  • ${f.name}: ${f.message}`));
        process.exit(1);
    }
    process.exit(0);
})();
