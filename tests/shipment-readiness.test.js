'use strict';
/**
 * Shipment Readiness Score Engine — PURE scoring unit tests (Prompt 6).
 *
 * NOTE: jest is currently broken repo-wide (jest-runtime clearMocksOnScope skew),
 * so the authoritative gate is the standalone harness:
 *     node tests/shipment-readiness.verify.js
 * This file mirrors those assertions in jest form for when the runner is fixed.
 */
const scoring = require('../service/readiness/scoring');

const NOW = new Date('2026-06-11T00:00:00Z');
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
const ready = (over = {}) => scoring.compute({ shipment: GOOD_SHIPMENT, documents: FULL_DOCS, workflowState: 'IN_TRANSIT', now: NOW, ...over });

describe('readiness scoring — model invariants', () => {
    test('component weights sum to 100', () => {
        expect(Object.values(scoring.WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    });
    test('bands at the documented thresholds', () => {
        expect(scoring.bandFor(80)).toBe('high');
        expect(scoring.bandFor(50)).toBe('medium');
        expect(scoring.bandFor(49.99)).toBe('low');
    });
});

describe('readiness scoring — outputs', () => {
    test('emits the five required outputs in range', () => {
        const r = ready();
        for (const k of ['readiness_score', 'compliance_score', 'documentation_score', 'logistics_score', 'risk_score']) {
            expect(typeof r[k]).toBe('number');
            expect(r[k]).toBeGreaterThanOrEqual(0);
            expect(r[k]).toBeLessThanOrEqual(100);
        }
    });
    test('fully-ready shipment is high with no blockers', () => {
        const r = ready();
        expect(r.documentation_score).toBe(100);
        expect(r.logistics_score).toBe(100);
        expect(r.risk_score).toBe(100);
        expect(r.band).toBe('high');
        expect(r.blockers).toHaveLength(0);
    });
    test('readiness is the weighted blend of components', () => {
        const r = ready();
        const w = scoring.WEIGHTS;
        const expected = r.documentation_score / 100 * w.documentation
            + r.compliance_score / 100 * w.compliance
            + r.logistics_score / 100 * w.logistics
            + r.risk_score / 100 * w.risk;
        expect(Math.abs(r.readiness_score - expected)).toBeLessThan(0.05);
    });
});

describe('readiness scoring — components', () => {
    test('missing docs zero documentation + 4 blockers', () => {
        const r = ready({ documents: [] });
        expect(r.documentation_score).toBe(0);
        expect(r.blockers.filter((b) => b.component === 'documentation')).toHaveLength(4);
    });
    test('no workflow → status-derived compliance', () => {
        const r = ready({ workflowState: null });
        expect(r.compliance_score).toBe(60);
    });
    test('incomplete logistics flags each gap', () => {
        const r = scoring.compute({ shipment: { id: 's2', tenant_id: 'T', status: 'booked' }, documents: FULL_DOCS, workflowState: 'CREATED', now: NOW });
        expect(r.logistics_score).toBe(0);
        expect(r.blockers.filter((b) => b.component === 'logistics')).toHaveLength(6);
    });
});

describe('readiness scoring — risk', () => {
    test('critical validation slashes risk', () => {
        const r = ready({ validations: [{ document_ref: 'd1', status: 'failed', critical_count: 1, high_count: 0 }] });
        expect(r.risk_score).toBe(40);
        expect(r.blockers.some((b) => b.code === 'VALIDATION_CRITICAL')).toBe(true);
    });
    test('sanctions hold is a major risk hit', () => {
        expect(ready({ sanctionsHold: true }).risk_score).toBe(30);
    });
    test('uninsured high value flags risk; insured does not', () => {
        expect(ready({ shipment: { ...GOOD_SHIPMENT, declared_value: 250000 }, insured: false }).risk_score).toBe(80);
        expect(ready({ shipment: { ...GOOD_SHIPMENT, declared_value: 250000 }, insured: true }).risk_score).toBe(100);
    });
});

describe('readiness scoring — hard clamps', () => {
    test('cancelled shipment clamped to <= 10', () => {
        const r = ready({ shipment: { ...GOOD_SHIPMENT, status: 'cancelled' } });
        expect(r.readiness_score).toBeLessThanOrEqual(10);
        expect(r.capped).toBe(true);
    });
    test('FAILED workflow clamped to <= 10', () => {
        const r = ready({ workflowState: 'FAILED', workflow: { failure_reason: 'x' } });
        expect(r.readiness_score).toBeLessThanOrEqual(10);
        expect(r.compliance_score).toBe(0);
    });
    test('trouble status clamped to <= 60', () => {
        const r = ready({ shipment: { ...GOOD_SHIPMENT, status: 'customs_hold' }, workflowState: 'COMPLIANCE_CHECK' });
        expect(r.readiness_score).toBeLessThanOrEqual(60);
    });
});

describe('readiness scoring — determinism', () => {
    test('identical inputs → identical output', () => {
        expect(ready()).toEqual(ready());
    });
    test('null shipment degrades safely', () => {
        const r = scoring.compute({ shipment: null });
        expect(r.readiness_score).toBe(0);
        expect(r.capped).toBe(true);
    });
});
