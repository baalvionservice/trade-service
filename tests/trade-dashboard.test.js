'use strict';
// Trade Operations Dashboard — tests (War Room 4, Prompt 3).
//
// Two suites:
//   1. Pure policy — readiness scorer + RBAC matrix + scope predicate. No DB,
//      always runs. Proves determinism, weighting, clamps and access rules.
//   2. Service (DB-backed) — listing/filters/pagination, merged timeline,
//      readiness, document visibility, comment append, and tenant isolation,
//      exercised directly against the service layer (the same precedent as the
//      shipment-workflow engine suite). Skips gracefully when no DB is reachable.
//      The HTTP layer's auth is the gateway HMAC boundary (authMiddleware) which
//      is covered by the gateway/bffBridge suites; RBAC/scope logic here is
//      verified through the pure suites + the service calls.

const readiness = require('../service/dashboard/readiness');
const rbac = require('../service/dashboard/rbac');
const svc = require('../service/dashboard/dashboardService');

// ───────────────────────────────────────────────────────────────────────────
// 1. PURE — READINESS SCORER
// ───────────────────────────────────────────────────────────────────────────
describe('readiness.compute (pure, deterministic)', () => {
    const NOW = new Date('2026-06-11T00:00:00Z');

    const fullDocs = [
        { doc_type: 'commercial_invoice', status: 'verified' },
        { doc_type: 'packing_list', status: 'verified' },
        { doc_type: 'bill_of_lading', status: 'verified' },
        { doc_type: 'certificate_of_origin', status: 'verified' },
    ];
    const goodShipment = {
        id: 's1', tenant_id: 'T-DEMO', status: 'in_transit',
        carrier_id: 'CR-1', carrier_name: 'Maersk', mode: 'sea',
        tracking_number: 'TRK1', origin_port: 'CNSHA', destination_port: 'USLGB',
        bill_of_lading_no: 'BL1', estimated_arrival: '2026-06-20T00:00:00Z',
    };

    test('is deterministic — same input yields same score', () => {
        const a = readiness.compute({ shipment: goodShipment, documents: fullDocs, workflowState: 'IN_TRANSIT', now: NOW });
        const b = readiness.compute({ shipment: goodShipment, documents: fullDocs, workflowState: 'IN_TRANSIT', now: NOW });
        expect(a.score).toBe(b.score);
    });

    test('a fully-papered, on-time, in-transit shipment scores high', () => {
        const r = readiness.compute({ shipment: goodShipment, documents: fullDocs, workflowState: 'IN_TRANSIT', now: NOW });
        expect(r.score).toBeGreaterThanOrEqual(80);
        expect(r.band).toBe('high');
        expect(r.blockers).toHaveLength(0);
    });

    test('missing documents lower the documentation component and add blockers', () => {
        const r = readiness.compute({ shipment: goodShipment, documents: [], workflowState: 'IN_TRANSIT', now: NOW });
        expect(r.components.documentation).toBe(0);
        expect(r.blockers.some((b) => b.code === 'DOC_MISSING')).toBe(true);
        expect(r.score).toBeLessThan(80);
    });

    test('cancelled shipment is hard-capped to <=10 regardless of docs', () => {
        const r = readiness.compute({ shipment: { ...goodShipment, status: 'cancelled' }, documents: fullDocs, workflowState: 'IN_TRANSIT', now: NOW });
        expect(r.score).toBeLessThanOrEqual(10);
        expect(r.capped).toBe(true);
        expect(r.band).toBe('low');
    });

    test('FAILED workflow is hard-capped to <=10', () => {
        const r = readiness.compute({ shipment: goodShipment, documents: fullDocs, workflowState: 'FAILED', now: NOW });
        expect(r.score).toBeLessThanOrEqual(10);
        expect(r.capped).toBe(true);
    });

    test('customs_hold caps to <=60 (never green)', () => {
        const r = readiness.compute({ shipment: { ...goodShipment, status: 'customs_hold' }, documents: fullDocs, workflowState: 'COMPLIANCE_CHECK', now: NOW });
        expect(r.score).toBeLessThanOrEqual(60);
        expect(r.capped).toBe(true);
    });

    test('overdue shipment degrades the schedule component and flags OVERDUE', () => {
        const overdue = { ...goodShipment, estimated_arrival: '2026-06-01T00:00:00Z' }; // 10 days before NOW
        const r = readiness.compute({ shipment: overdue, documents: fullDocs, workflowState: 'IN_TRANSIT', now: NOW });
        expect(r.components.schedule).toBe(0);
        expect(r.blockers.some((b) => b.code === 'OVERDUE')).toBe(true);
    });

    test('no shipment → zero score, NOT_FOUND blocker', () => {
        const r = readiness.compute({ shipment: null });
        expect(r.score).toBe(0);
        expect(r.blockers[0].code).toBe('NOT_FOUND');
    });

    test('weights sum to 100', () => {
        const sum = Object.values(readiness.WEIGHTS).reduce((a, b) => a + b, 0);
        expect(sum).toBe(100);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 1b. PURE — RBAC MATRIX + SCOPE PREDICATE
// ───────────────────────────────────────────────────────────────────────────
describe('rbac.resolve (pure)', () => {
    test('admin / super_admin / owner → full access, tenant-wide scope', () => {
        for (const role of ['admin', 'super_admin', 'owner']) {
            const a = rbac.resolve([role]);
            expect(a).toMatchObject({ allowed: true, canComment: true, scope: 'all', isAdmin: true });
        }
    });

    test('logistics + bank → tenant-wide read + comment, not admin', () => {
        for (const role of ['logistics', 'bank']) {
            const a = rbac.resolve([role]);
            expect(a).toMatchObject({ allowed: true, scope: 'all', isAdmin: false });
        }
    });

    test('buyer → buyer scope, seller → seller scope', () => {
        expect(rbac.resolve(['buyer']).scope).toBe('buyer');
        expect(rbac.resolve(['seller']).scope).toBe('seller');
    });

    test('buyer + seller → party scope', () => {
        expect(rbac.resolve(['buyer', 'seller']).scope).toBe('party');
    });

    test('no recognised role → denied, fail-closed', () => {
        const a = rbac.resolve(['client']);
        expect(a.allowed).toBe(false);
        expect(a.scope).toBe('none');
    });

    test('bank cannot see internal-only document types; admin can', () => {
        const bank = rbac.resolve(['bank']);
        const admin = rbac.resolve(['admin']);
        expect(rbac.canSeeDocument(bank, 'compliance_note')).toBe(false);
        expect(rbac.canSeeDocument(bank, 'bill_of_lading')).toBe(true);
        expect(rbac.canSeeDocument(admin, 'compliance_note')).toBe(true);
    });
});

describe('dashboardService.isOperationInScope (pure)', () => {
    const op = { buyer_org_id: 'COMP-101', seller_org_id: 'COMP-102' };

    test('all-scope sees any operation', () => {
        expect(svc.isOperationInScope(op, { scope: 'all' }, [])).toBe(true);
    });
    test('buyer-scope only sees its own buyer operations', () => {
        expect(svc.isOperationInScope(op, { scope: 'buyer' }, ['COMP-101'])).toBe(true);
        expect(svc.isOperationInScope(op, { scope: 'buyer' }, ['COMP-999'])).toBe(false);
    });
    test('seller-scope only sees its own seller operations', () => {
        expect(svc.isOperationInScope(op, { scope: 'seller' }, ['COMP-102'])).toBe(true);
        expect(svc.isOperationInScope(op, { scope: 'seller' }, ['COMP-101'])).toBe(false);
    });
    test('party-scope sees either side', () => {
        expect(svc.isOperationInScope(op, { scope: 'party' }, ['COMP-102'])).toBe(true);
        expect(svc.isOperationInScope(op, { scope: 'party' }, ['COMP-101'])).toBe(true);
        expect(svc.isOperationInScope(op, { scope: 'party' }, ['COMP-999'])).toBe(false);
    });
    test('non-admin with no resolvable party org is fail-closed', () => {
        expect(svc.isOperationInScope(op, { scope: 'buyer' }, [])).toBe(false);
    });
    test('clampPagination bounds page/limit', () => {
        expect(svc.clampPagination({ page: 0, limit: 0 })).toMatchObject({ page: 1, limit: svc.DEFAULT_LIMIT });
        expect(svc.clampPagination({ page: 3, limit: 9999 })).toMatchObject({ page: 3, limit: svc.MAX_LIMIT });
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. SERVICE (DB-backed) — skips when no DB. Mirrors the workflow engine suite:
//    writes run on the dev owner connection (RLS bypassed); tenant filtering is
//    exercised through the service's own tenant/scope params, not ALS.
// ───────────────────────────────────────────────────────────────────────────
describe('dashboardService (DB-backed)', () => {
    let db; let dbUp = false;
    const STAMP = `${Date.now()}`;
    const TENANT = `T-DASH-${STAMP}`;
    const OTHER_TENANT = `T-OTHER-${STAMP}`;
    const BUYER = `COMP-B-${STAMP}`;
    const SELLER = `COMP-S-${STAMP}`;
    const adminAccess = { scope: 'all', isAdmin: true, canComment: true };
    const buyerAccess = { scope: 'buyer', isAdmin: false, canComment: true };
    let shipment; // owning-tenant shipment instance

    beforeAll(async () => {
        db = require('../models');
        try {
            await db.sequelize.authenticate();
            await require('../migrate').run();
            dbUp = true;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[dashboard] DB unavailable — skipping service suite:', err.message);
            return;
        }

        // Owning-tenant graph.
        const op = await db.TradeOperation.create({
            tenant_id: TENANT, reference_no: `TO-${STAMP}`, buyer_org_id: BUYER, seller_org_id: SELLER,
            commodity: 'Test Goods', status: 'in_transit', priority: 'normal', currency: 'USD', created_by: 'test',
        });
        shipment = await db.TradeShipment.create({
            tenant_id: TENANT, trade_operation_id: op.id, shipment_no: `SHP-${STAMP}`, carrier_name: 'TestLine',
            mode: 'sea', tracking_number: 'TRKD', origin_port: 'CNSHA', destination_port: 'USLGB',
            bill_of_lading_no: 'BLD', status: 'in_transit', estimated_arrival: new Date(Date.now() + 5 * 86400000), created_by: 'test',
        });
        await db.ShipmentEvent.create({ tenant_id: TENANT, shipment_id: shipment.id, event_type: 'departed', event_code: 'DEP', description: 'Departed origin', occurred_at: new Date(Date.now() - 86400000), source: 'carrier' });
        await db.ShipmentStatusHistory.create({ tenant_id: TENANT, shipment_id: shipment.id, from_status: 'booked', to_status: 'in_transit', reason: 'departed', changed_by: 'test', changed_at: new Date(Date.now() - 86400000) });
        await db.ShipmentDocument.bulkCreate([
            { tenant_id: TENANT, shipment_id: shipment.id, trade_operation_id: op.id, doc_type: 'bill_of_lading', title: 'BoL', status: 'verified' },
            { tenant_id: TENANT, shipment_id: shipment.id, trade_operation_id: op.id, doc_type: 'compliance_note', title: 'Internal memo', status: 'verified' },
        ]);

        // A different tenant's graph — must NOT be visible to TENANT's tenant-scoped reads.
        const op2 = await db.TradeOperation.create({
            tenant_id: OTHER_TENANT, reference_no: `TO-OTHER-${STAMP}`, buyer_org_id: 'COMP-X', seller_org_id: 'COMP-Y',
            commodity: 'Other Goods', status: 'active', priority: 'normal', currency: 'USD', created_by: 'test',
        });
        await db.TradeShipment.create({
            tenant_id: OTHER_TENANT, trade_operation_id: op2.id, shipment_no: `SHP-OTHER-${STAMP}`, carrier_name: 'OtherLine',
            mode: 'air', status: 'booked', created_by: 'test',
        });
    });

    afterAll(async () => {
        if (!dbUp) return;
        for (const tenant of [TENANT, OTHER_TENANT]) {
            try {
                await db.ShipmentEvent.destroy({ where: { tenant_id: tenant }, force: true });
                await db.ShipmentStatusHistory.destroy({ where: { tenant_id: tenant } });
                await db.ShipmentDocument.destroy({ where: { tenant_id: tenant }, force: true });
                await db.TradeShipment.destroy({ where: { tenant_id: tenant }, force: true });
                await db.TradeOperation.destroy({ where: { tenant_id: tenant }, force: true });
            } catch { /* best-effort */ }
        }
        try { await db.sequelize.close(); } catch { /* ignore */ }
    });

    const maybe = (name, fn) => test(name, async () => { if (dbUp) await fn(); });

    maybe('lists shipments for the owning tenant and excludes other tenants', async () => {
        const res = await svc.listShipments({ tenantId: TENANT, bypass: false, access: adminAccess, partyOrgIds: [] });
        expect(res.items.length).toBeGreaterThanOrEqual(1);
        expect(res.items.every((s) => s.tenant_id === TENANT)).toBe(true);
        expect(res.items.some((s) => s.tenant_id === OTHER_TENANT)).toBe(false);
        expect(res).toMatchObject({ page: 1 });
        expect(typeof res.total).toBe('number');
    });

    maybe('status + buyer filters narrow the result set', async () => {
        const hit = await svc.listShipments({ tenantId: TENANT, bypass: false, access: adminAccess, partyOrgIds: [], status: ['in_transit'], buyer: BUYER });
        expect(hit.items.length).toBeGreaterThanOrEqual(1);
        const miss = await svc.listShipments({ tenantId: TENANT, bypass: false, access: adminAccess, partyOrgIds: [], status: ['cancelled'] });
        expect(miss.items.length).toBe(0);
    });

    maybe('buyer-scope caller sees its party shipments; a stranger buyer sees none', async () => {
        const mine = await svc.listShipments({ tenantId: TENANT, bypass: false, access: buyerAccess, partyOrgIds: [BUYER] });
        expect(mine.items.length).toBeGreaterThanOrEqual(1);
        const stranger = await svc.listShipments({ tenantId: TENANT, bypass: false, access: buyerAccess, partyOrgIds: ['COMP-NOPE'] });
        expect(stranger.items.length).toBe(0);
    });

    maybe('getShipmentScoped hides the shipment from an out-of-party buyer', async () => {
        const visible = await svc.getShipmentScoped(shipment.id, { access: buyerAccess, partyOrgIds: [BUYER] });
        expect(visible).not.toBeNull();
        const hidden = await svc.getShipmentScoped(shipment.id, { access: buyerAccess, partyOrgIds: ['COMP-NOPE'] });
        expect(hidden).toBeNull();
    });

    maybe('timeline merges events + status history chronologically', async () => {
        const tl = await svc.getTimeline(shipment.id);
        expect(tl.entries.length).toBeGreaterThanOrEqual(2);
        const kinds = tl.entries.map((e) => e.kind);
        expect(kinds).toEqual(expect.arrayContaining(['event', 'status_change']));
        const times = tl.entries.map((e) => new Date(e.at).getTime());
        expect(times).toEqual([...times].sort((a, b) => a - b)); // ascending
    });

    maybe('document visibility hides bank-restricted types from non-admin all-scope', async () => {
        const adminDocs = await svc.getDocuments(shipment.id, adminAccess, rbac.canSeeDocument);
        expect(adminDocs.some((d) => d.doc_type === 'compliance_note')).toBe(true);
        const bankAccess = { scope: 'all', isAdmin: false, canComment: true };
        const bankDocs = await svc.getDocuments(shipment.id, bankAccess, rbac.canSeeDocument);
        expect(bankDocs.some((d) => d.doc_type === 'compliance_note')).toBe(false);
        expect(bankDocs.some((d) => d.doc_type === 'bill_of_lading')).toBe(true);
    });

    maybe('readiness computes from live docs + status', async () => {
        const r = await svc.computeReadiness(shipment);
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('components');
        expect(r.score).toBeGreaterThan(0);
    });

    maybe('addComment appends a comment event that surfaces in the timeline', async () => {
        const before = await svc.getTimeline(shipment.id);
        await svc.addComment(shipment, { message: 'Customs docs uploaded', actor: 'tester' });
        const after = await svc.getTimeline(shipment.id);
        expect(after.entries.length).toBe(before.entries.length + 1);
        expect(after.entries.some((e) => e.kind === 'comment' && e.description === 'Customs docs uploaded')).toBe(true);
    });
});
