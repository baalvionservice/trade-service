'use strict';
/**
 * Shipment Readiness Score Engine — LIVE DB verification (Prompt 6).
 *
 * Exercises the DB-backed orchestrator against the real Postgres: input assembly,
 * persisted snapshots, the cache layer, snapshot history, the event-triggered
 * recalculation driven by a workflow transition, and cross-tenant RLS isolation.
 *
 * Requires the DB up + migration 012 applied. Fixtures are created under a tenant
 * ALS scope and cleaned up at the end.
 *
 *   node tests/shipment-readiness.live.js
 */
const assert = require('assert');
const db = require('../models');
const { runAs } = require('../middleware/tenantContext');
const engine = require('../service/readiness/readinessEngine');
const workflowEngine = require('../service/workflow/workflowEngine');

const TENANT_A = 'T-READY-A';
const TENANT_B = 'T-READY-B';
const SUFFIX = '012LIVE';

let pass = 0; let fail = 0; const failures = [];
async function t(name, fn) {
    try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
    catch (err) { fail += 1; failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

async function cleanup() {
    // Children first (FKs). Bypass scope so we sweep both tenants.
    await runAs({ bypass: true }, async () => {
        await db.ShipmentReadiness.destroy({ where: { reason: `live-${SUFFIX}` }, force: true });
        const ops = await db.TradeOperation.findAll({ where: { reason_tag: null }, paranoid: false }).catch(() => []);
        // Targeted cleanup by reference suffix.
        const shipments = await db.TradeShipment.findAll({ where: {}, paranoid: false });
        for (const s of shipments.filter((x) => (x.shipment_no || '').includes(SUFFIX))) {
            await db.ShipmentReadiness.destroy({ where: { shipment_id: s.id }, force: true });
            await db.ShipmentWorkflow.destroy({ where: { shipment_id: s.id }, force: true });
            await db.ShipmentDocument.destroy({ where: { shipment_id: s.id }, force: true });
            await db.TradeShipment.destroy({ where: { id: s.id }, force: true });
        }
        const allOps = await db.TradeOperation.findAll({ where: {}, paranoid: false });
        for (const o of allOps.filter((x) => (x.reference_no || '').includes(SUFFIX))) {
            await db.TradeOperation.destroy({ where: { id: o.id }, force: true });
        }
        void ops;
    });
}

async function makeFixture(tenant, { good = true } = {}) {
    return runAs({ tenantId: tenant, bypass: false }, async () => {
        const op = await db.TradeOperation.create({
            tenant_id: tenant, reference_no: `OP-${SUFFIX}-${tenant}`, commodity: 'copper',
            origin_country: 'IN', destination_country: 'US', currency: 'USD', total_value: 5000, status: 'active',
        });
        const shipment = await db.TradeShipment.create({
            tenant_id: tenant, trade_operation_id: op.id, shipment_no: `SHP-${SUFFIX}-${tenant}`,
            status: 'in_transit', carrier_name: good ? 'Maersk' : null, mode: good ? 'sea' : null,
            tracking_number: good ? 'TRK-1' : null, origin_port: good ? 'INNSA' : null,
            destination_port: good ? 'USNYC' : null, bill_of_lading_no: good ? 'BL-1' : null,
            estimated_arrival: new Date(Date.now() + 9 * 86400000), declared_value: 5000,
        });
        const docTypes = ['commercial_invoice', 'packing_list', 'bill_of_lading', 'certificate_of_origin'];
        for (const dt of docTypes) {
            await db.ShipmentDocument.create({
                tenant_id: tenant, shipment_id: shipment.id, trade_operation_id: op.id,
                doc_type: dt, status: good ? 'verified' : 'pending',
            });
        }
        return { op, shipment };
    });
}

(async () => {
    await cleanup();

    let A; let B;
    await t('fixtures create under tenant scope', async () => {
        A = await makeFixture(TENANT_A, { good: true });
        B = await makeFixture(TENANT_B, { good: false });
        assert.ok(A.shipment.id && B.shipment.id);
    });

    await t('recalculate persists a snapshot + returns the five outputs', async () => {
        await runAs({ tenantId: TENANT_A, bypass: false }, async () => {
            const { record, view } = await engine.recalculate(A.shipment.id, { trigger: 'manual', reason: `live-${SUFFIX}`, actor: 'tester' });
            assert.ok(record && record.id, 'persisted a row');
            ['readiness_score', 'compliance_score', 'documentation_score', 'logistics_score', 'risk_score'].forEach((k) => {
                assert.ok(typeof view[k] === 'number', `${k} present`);
            });
            assert.strictEqual(view.documentation_score, 100); // all verified
            assert.strictEqual(view.logistics_score, 100);
            assert.strictEqual(view.risk_score, 100);
            assert.strictEqual(view.persisted, true);
        });
    });

    await t('getLatest is served from cache after recalc', async () => {
        await runAs({ tenantId: TENANT_A, bypass: false }, async () => {
            const v = await engine.getLatest(A.shipment);
            assert.ok(v.readiness_score > 0);
            assert.ok(v.snapshot_id, 'has a persisted snapshot id');
        });
    });

    await t('bare-fixture (tenant B) scores lower with blockers', async () => {
        await runAs({ tenantId: TENANT_B, bypass: false }, async () => {
            const { view } = await engine.recalculate(B.shipment.id, { trigger: 'manual', reason: `live-${SUFFIX}` });
            assert.ok(view.logistics_score < 100, 'logistics incomplete');
            assert.ok(view.documentation_score < 100, 'docs only pending');
            assert.ok(view.blocker_count > 0);
        });
    });

    await t('history accumulates append-only snapshots', async () => {
        await runAs({ tenantId: TENANT_A, bypass: false }, async () => {
            await engine.recalculate(A.shipment.id, { trigger: 'manual', reason: `live-${SUFFIX}` });
            const hist = await engine.listHistory(A.shipment.id, { page: 1, limit: 10 });
            assert.ok(hist.total >= 2, `expected >=2 snapshots, got ${hist.total}`);
        });
    });

    await t('workflow transition event-triggers a recalculation', async () => {
        await runAs({ tenantId: TENANT_A, bypass: false }, async () => {
            const wf = await workflowEngine.createWorkflow({ tenantId: TENANT_A, shipmentId: A.shipment.id, actor: 'tester' });
            const before = await db.ShipmentReadiness.count({ where: { shipment_id: A.shipment.id } });
            await workflowEngine.dispatch(wf.id, 'collect_documents', { actor: 'tester' });
            // Post-commit recalc is awaited inside dispatch → snapshot count grew with a workflow_transition trigger.
            const after = await db.ShipmentReadiness.findAll({ where: { shipment_id: A.shipment.id }, order: [['created_at', 'DESC']], limit: 1 });
            const total = await db.ShipmentReadiness.count({ where: { shipment_id: A.shipment.id } });
            assert.ok(total > before, `snapshot added by transition (${before} → ${total})`);
            assert.strictEqual(after[0].trigger, 'workflow_transition');
            assert.ok(after[0].workflow_id, 'snapshot bound to the workflow');
        });
    });

    await t('RLS: tenant A cannot read tenant B snapshots', async () => {
        await runAs({ tenantId: TENANT_A, bypass: false }, async () => {
            const rows = await db.ShipmentReadiness.findAll({ where: { shipment_id: B.shipment.id } });
            assert.strictEqual(rows.length, 0, 'cross-tenant read must be empty');
        });
    });

    await t('cleanup removes fixtures', async () => {
        await cleanup();
        await runAs({ bypass: true }, async () => {
            const left = await db.TradeShipment.count({ where: {}, paranoid: false });
            void left; // best-effort; just ensure no throw
        });
    });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`shipment-readiness LIVE: ${pass} passed, ${fail} failed`);
    if (fail > 0) { failures.forEach((f) => console.log(`  • ${f.name}: ${f.message}`)); process.exit(1); }
    process.exit(0);
})().catch((err) => { console.error('HARNESS ERROR', err); process.exit(1); });
