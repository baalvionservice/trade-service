'use strict';
// Shipment Workflow State Machine — tests (War Room 4, Prompt 2).
//
// Two suites:
//   1. Pure state-machine — no DB, always runs. Proves determinism, the full
//      happy path, invalid-transition blocking and terminal handling.
//   2. Engine (DB-backed) — idempotency, retry-safety, optimistic apply, event
//      log persistence. Skips gracefully when no DB is reachable.

const sm = require('../service/workflow/stateMachine');

// ───────────────────────────────────────────────────────────────────────────
// 1. PURE STATE MACHINE
// ───────────────────────────────────────────────────────────────────────────
describe('stateMachine (pure, deterministic)', () => {
    const HAPPY_PATH = [
        ['CREATED', 'collect_documents', 'DOCUMENT_COLLECTION'],
        ['DOCUMENT_COLLECTION', 'submit_documents', 'DOCUMENT_VERIFICATION'],
        ['DOCUMENT_VERIFICATION', 'verify_documents', 'COMPLIANCE_CHECK'],
        ['COMPLIANCE_CHECK', 'clear_compliance', 'HS_CLASSIFICATION'],
        ['HS_CLASSIFICATION', 'classify_hs', 'CUSTOMS_READY'],
        ['CUSTOMS_READY', 'book_freight', 'FREIGHT_BOOKED'],
        ['FREIGHT_BOOKED', 'ready_dispatch', 'DISPATCH_READY'],
        ['DISPATCH_READY', 'dispatch', 'DISPATCHED'],
        ['DISPATCHED', 'depart', 'IN_TRANSIT'],
        ['IN_TRANSIT', 'deliver', 'DELIVERED'],
        ['DELIVERED', 'complete', 'COMPLETED'],
    ];

    test('exposes the 13 canonical states', () => {
        expect(sm.ALL_STATES).toHaveLength(13);
        expect(sm.INITIAL_STATE).toBe('CREATED');
        expect(sm.TERMINAL_STATES).toEqual(expect.arrayContaining(['COMPLETED', 'FAILED']));
    });

    test('drives the full happy path CREATED → COMPLETED', () => {
        let state = sm.INITIAL_STATE;
        for (const [from, event, to] of HAPPY_PATH) {
            expect(state).toBe(from);
            const d = sm.decide(state, event);
            expect(d.ok).toBe(true);
            expect(d.to).toBe(to);
            state = d.to;
        }
        expect(state).toBe('COMPLETED');
        expect(sm.statusForState(state)).toBe('completed');
        expect(sm.isTerminal(state)).toBe(true);
        expect(sm.allowedEvents(state)).toEqual([]);
    });

    test('is deterministic — every (state, event) yields a single target', () => {
        for (const state of sm.ALL_STATES) {
            for (const event of sm.allowedEvents(state)) {
                const a = sm.decide(state, event);
                const b = sm.decide(state, event);
                expect(a.ok).toBe(true);
                expect(a.to).toBe(b.to); // same input → same output
            }
        }
    });

    test('blocks an invalid transition (skipping a stage)', () => {
        const d = sm.decide('CREATED', 'dispatch'); // cannot jump straight to dispatch
        expect(d.ok).toBe(false);
        expect(d.code).toBe('INVALID_TRANSITION');
        expect(d.allowed).toContain('collect_documents');
    });

    test('blocks any transition from a terminal state', () => {
        for (const terminal of ['COMPLETED', 'FAILED']) {
            const d = sm.decide(terminal, 'collect_documents');
            expect(d.ok).toBe(false);
            expect(d.code).toBe('TERMINAL_STATE');
        }
    });

    test('rejects unknown events and unknown states', () => {
        expect(sm.decide('CREATED', 'teleport').code).toBe('UNKNOWN_EVENT');
        expect(sm.decide('NOWHERE', 'collect_documents').code).toBe('UNKNOWN_STATE');
    });

    test('fail is allowed from every non-terminal state and lands on FAILED', () => {
        for (const state of sm.NON_TERMINAL) {
            const d = sm.decide(state, 'fail');
            expect(d.ok).toBe(true);
            expect(d.to).toBe('FAILED');
        }
        // ...but never from a terminal state.
        expect(sm.decide('COMPLETED', 'fail').ok).toBe(false);
    });

    test('reject_documents loops verification back to collection (rework)', () => {
        const d = sm.decide('DOCUMENT_VERIFICATION', 'reject_documents');
        expect(d.ok).toBe(true);
        expect(d.to).toBe('DOCUMENT_COLLECTION');
        expect(d.kind).toBe('rework');
    });

    test('nextForwardState matches the happy path and is null at terminals', () => {
        expect(sm.nextForwardState('CREATED')).toBe('DOCUMENT_COLLECTION');
        expect(sm.nextForwardState('DELIVERED')).toBe('COMPLETED');
        expect(sm.nextForwardState('COMPLETED')).toBeNull();
        expect(sm.nextForwardState('FAILED')).toBeNull();
    });

    test('statusForState rolls states up correctly', () => {
        expect(sm.statusForState('CREATED')).toBe('active');
        expect(sm.statusForState('IN_TRANSIT')).toBe('active');
        expect(sm.statusForState('COMPLETED')).toBe('completed');
        expect(sm.statusForState('FAILED')).toBe('failed');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. ENGINE (DB-backed) — idempotency, retry-safety, event log persistence
// ───────────────────────────────────────────────────────────────────────────
describe('workflowEngine (DB-backed)', () => {
    let db;
    let engine;
    let dbAvailable = false;
    const created = [];

    beforeAll(async () => {
        db = require('../models');
        engine = require('../service/workflow/workflowEngine');
        try {
            await db.sequelize.authenticate();
            // Ensure the workflow tables exist (run pending migrations).
            await require('../migrate').run();
            dbAvailable = true;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[shipment-workflow] DB unavailable — skipping engine suite:', err.message);
        }
    });

    afterAll(async () => {
        if (!dbAvailable) return;
        for (const id of created) {
            try { await db.WorkflowTransition.destroy({ where: { workflow_id: id }, force: true }); } catch { /* noop */ }
            try { await db.ShipmentWorkflow.destroy({ where: { id }, force: true }); } catch { /* noop */ }
        }
        try { await db.sequelize.close(); } catch { /* noop */ }
    });

    const maybe = (name, fn) => test(name, async () => {
        if (!dbAvailable) return; // soft-skip
        await fn();
    });

    maybe('creates a workflow in CREATED and advances it', async () => {
        const wf = await engine.createWorkflow({ tenantId: 'T-TEST', reference: `WF-TEST-${Date.now()}` });
        created.push(wf.id);
        expect(wf.current_state).toBe('CREATED');
        const r = await engine.dispatch(wf.id, 'collect_documents', { actor: 'tester' });
        expect(r.workflow.current_state).toBe('DOCUMENT_COLLECTION');
        expect(r.transition.seq).toBe(1);
        expect(r.idempotent).toBe(false);
    });

    maybe('is idempotent — replaying the same key does not double-apply', async () => {
        const wf = await engine.createWorkflow({ tenantId: 'T-TEST', reference: `WF-IDEM-${Date.now()}` });
        created.push(wf.id);
        const key = `idem-${Date.now()}`;
        const first = await engine.dispatch(wf.id, 'collect_documents', { idempotencyKey: key, actor: 'tester' });
        const second = await engine.dispatch(wf.id, 'collect_documents', { idempotencyKey: key, actor: 'tester' });
        expect(first.idempotent).toBe(false);
        expect(second.idempotent).toBe(true);
        expect(second.transition.id).toBe(first.transition.id); // same recorded transition
        const count = await db.WorkflowTransition.count({ where: { workflow_id: wf.id } });
        expect(count).toBe(1); // exactly one transition despite two dispatches
    });

    maybe('blocks an invalid transition at the engine boundary', async () => {
        const wf = await engine.createWorkflow({ tenantId: 'T-TEST', reference: `WF-INV-${Date.now()}` });
        created.push(wf.id);
        await expect(engine.dispatch(wf.id, 'dispatch', { actor: 'tester' }))
            .rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });
        // state is unchanged after a blocked transition.
        const fresh = await db.ShipmentWorkflow.findByPk(wf.id);
        expect(fresh.current_state).toBe('CREATED');
    });

    maybe('persists an append-only event log across the full lifecycle', async () => {
        const wf = await engine.createWorkflow({ tenantId: 'T-TEST', reference: `WF-LIFE-${Date.now()}` });
        created.push(wf.id);
        const events = ['collect_documents', 'submit_documents', 'verify_documents', 'clear_compliance',
            'classify_hs', 'book_freight', 'ready_dispatch', 'dispatch', 'depart', 'deliver', 'complete'];
        for (const e of events) await engine.dispatch(wf.id, e, { actor: 'tester' });
        const fresh = await db.ShipmentWorkflow.findByPk(wf.id);
        expect(fresh.current_state).toBe('COMPLETED');
        expect(fresh.status).toBe('completed');
        const log = await db.WorkflowTransition.findAll({ where: { workflow_id: wf.id }, order: [['seq', 'ASC']] });
        expect(log).toHaveLength(events.length);
        expect(log.map((r) => r.seq)).toEqual(events.map((_, i) => i + 1)); // monotonic, gapless
    });

    maybe('records the failure reason on fail()', async () => {
        const wf = await engine.createWorkflow({ tenantId: 'T-TEST', reference: `WF-FAIL-${Date.now()}` });
        created.push(wf.id);
        await engine.dispatch(wf.id, 'fail', { actor: 'tester', reason: 'sanctions_hit' });
        const fresh = await db.ShipmentWorkflow.findByPk(wf.id);
        expect(fresh.current_state).toBe('FAILED');
        expect(fresh.status).toBe('failed');
        expect(fresh.failure_reason).toBe('sanctions_hit');
    });
});
