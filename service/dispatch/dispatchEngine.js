'use strict';
/**
 * Dispatch Orchestration Engine — DB-backed ORCHESTRATOR (War Room 4, Prompt 11).
 *
 * The automation layer that fires a shipment's dispatch the moment its four gates
 * clear — documents validated, compliance passed, customs ready, freight booked —
 * wrapping the PURE pieces with the durability they deliberately avoid:
 *
 *   • Rule engine   — ruleEngine.evaluate(conditions, rule) decides *dispatch now?*
 *                     A plan holds a condition-state map + a normalized rule; every
 *                     signal re-evaluates it. Default rule = ALL_OF the four gates.
 *
 *   • Event triggers — onWorkflowTransition() is the bridge the workflow engine
 *                     calls post-commit: a transition into COMPLIANCE_CHECK /
 *                     HS_CLASSIFICATION / CUSTOMS_READY / FREIGHT_BOOKED maps to a
 *                     gate signal. signalCondition() is the generic, idempotent
 *                     entry point (also reachable directly via the API). When the
 *                     rule flips to satisfied and the plan is auto-dispatch, the
 *                     dispatch saga fires automatically.
 *
 *   • Webhook system — every lifecycle event (condition signal, ready, dispatched,
 *                     failed, rolled_back) is fanned out to tenant webhook
 *                     subscriptions over the retry-safe `dispatch_webhook` queue
 *                     (HMAC-signed, SSRF-guarded, persisted delivery rows).
 *
 *   • Failure rollback — dispatch is a multi-step distributed action with no single
 *                     ACID boundary, so it runs as a SAGA: finalize customs →
 *                     release documents → notify carrier → advance the workflow. If
 *                     any step fails, the compensators of the already-completed
 *                     steps run in reverse. A clean compensation lands the plan in
 *                     `rolled_back` (recoverable); a compensation that itself fails
 *                     lands it in `failed` (flagged dirty for ops). The shipment is
 *                     never silently left half-dispatched.
 *
 * Concurrency: signalCondition / triggerDispatch lock the plan row (SELECT … FOR
 * UPDATE) and bump an optimistic `version`, so concurrent signals serialise and a
 * dispatch can never start twice.
 */
const crypto = require('crypto');
const db = require('../../models');
const schema = require('./schema');
const ruleEngine = require('./ruleEngine');
const saga = require('./saga');
const { AppError } = require('../../utils/errors');

const { STATUS, EVENT_TYPE, STEP } = schema;

// ── Lazy handles (avoid require cycles + eager Redis/connection opens). ───────
let dispatcher = null;
function webhookDispatcher() {
    if (!dispatcher) dispatcher = require('./webhookDispatcher');
    return dispatcher;
}
let workflow = null;
function workflowEngine() {
    if (!workflow) {
        try { workflow = require('../workflow/workflowEngine'); }
        catch { workflow = null; }
    }
    return workflow;
}
let enqueueFn = null;
let queueResolved = false;
function getEnqueue() {
    if (queueResolved) return enqueueFn;
    queueResolved = true;
    try { enqueueFn = require('../../queue').enqueue; } catch { enqueueFn = null; }
    return enqueueFn;
}

const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const nowIso = () => new Date().toISOString();

function newReference() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `DSP-${ts}-${rand}`;
}

/** Append an immutable lifecycle event (best-effort — never breaks the caller). */
async function appendEvent(plan, { eventType, message = null, detail = {}, step = null, condition = null, actor = null, idempotencyKey = null }, t = null) {
    if (!db.DispatchEvent) return null;
    try {
        const seq = (await db.DispatchEvent.count({ where: { plan_id: plan.id }, ...(t ? { transaction: t } : {}) })) + 1;
        return await db.DispatchEvent.create({
            tenant_id: plan.tenant_id,
            plan_id: plan.id,
            seq,
            event_type: eventType,
            step,
            condition,
            status: plan.status,
            message: message ? String(message).slice(0, 1000) : null,
            detail: detail || {},
            idempotency_key: idempotencyKey,
            created_by: actor || 'system',
        }, t ? { transaction: t } : {});
    } catch {
        return null; // events table missing / not migrated — degrade
    }
}

/** Normalize a plan row into the stable API view. */
function toView(row) {
    const p = plain(row);
    if (!p) return null;
    const rule = p.rule || {};
    const conditions = p.conditions || {};
    const decision = ruleEngine.evaluate(conditions, rule);
    return {
        id: p.id,
        reference_no: p.reference_no,
        status: p.status,
        workflow_id: p.workflow_id || null,
        shipment_id: p.shipment_id || null,
        trade_operation_id: p.trade_operation_id || null,
        auto_dispatch: p.auto_dispatch,
        rule,
        conditions,
        readiness: {
            satisfied: decision.satisfied,
            decision: decision.decision,
            held: decision.held,
            met: decision.met,
            missing: decision.missing,
            score: decision.score,
        },
        dispatch_steps: p.dispatch_steps || [],
        failure_reason: p.failure_reason || null,
        dispatched_at: p.dispatched_at || null,
        rolled_back_at: p.rolled_back_at || null,
        version: p.version,
        engine_version: p.engine_version,
        metadata: p.metadata || {},
        created_at: p.created_at || null,
        updated_at: p.updated_at || null,
    };
}

// ── Pluggable saga step handlers ─────────────────────────────────────────────
// Each handler is { execute(ctx) → result, compensate(ctx, result) }. Production
// wiring overrides these via registerStepHandler (mirrors the registerProvider /
// registerConnector pluggability elsewhere in trade-service). The defaults record
// an auditable event for each effect and ADVANCE_WORKFLOW genuinely drives the
// workflow state machine to DISPATCHED.
//
// ctx = { plan, planId, tenantId, actor, simulate, appendStepEvent }

function injectFailure(ctx, step) {
    if (ctx && ctx.simulate === `fail:${step}`) {
        const err = new Error(`simulated_failure:${step}`);
        err.simulated = true;
        throw err;
    }
}

const DEFAULT_STEP_HANDLERS = {
    [STEP.FINALIZE_CUSTOMS]: {
        execute: async (ctx) => {
            injectFailure(ctx, STEP.FINALIZE_CUSTOMS);
            return { finalized: true, at: nowIso() };
        },
        compensate: async () => ({ reverted: 'customs_finalization' }),
    },
    [STEP.RELEASE_DOCUMENTS]: {
        execute: async (ctx) => {
            injectFailure(ctx, STEP.RELEASE_DOCUMENTS);
            return { released: true, at: nowIso() };
        },
        compensate: async () => ({ reverted: 'documents_recalled' }),
    },
    [STEP.NOTIFY_CARRIER]: {
        execute: async (ctx) => {
            injectFailure(ctx, STEP.NOTIFY_CARRIER);
            // Best-effort carrier notification onto the durable notifications queue.
            const enqueue = getEnqueue();
            if (enqueue) {
                try {
                    await enqueue('notifications', 'dispatch_carrier', {
                        tenantId: ctx.tenantId,
                        kind: 'dispatch_booked',
                        planId: ctx.planId,
                        shipmentId: ctx.plan.shipment_id || null,
                    });
                } catch { /* notification is best-effort; the saga step still succeeds */ }
            }
            return { notified: true, at: nowIso() };
        },
        compensate: async (ctx) => {
            const enqueue = getEnqueue();
            if (enqueue) {
                try {
                    await enqueue('notifications', 'dispatch_carrier', {
                        tenantId: ctx.tenantId,
                        kind: 'dispatch_cancelled',
                        planId: ctx.planId,
                        shipmentId: ctx.plan.shipment_id || null,
                    });
                } catch { /* best-effort */ }
            }
            return { reverted: 'carrier_notified_cancellation' };
        },
    },
    [STEP.ADVANCE_WORKFLOW]: {
        execute: async (ctx) => {
            injectFailure(ctx, STEP.ADVANCE_WORKFLOW);
            const wf = workflowEngine();
            if (!wf || !ctx.plan.workflow_id) return { skipped: true, reason: 'no_workflow' };
            return driveWorkflowToDispatched(ctx.plan.workflow_id, { actor: ctx.actor });
        },
        // A forward-only state machine cannot be auto-reversed; record a
        // reconciliation flag for ops (only ever runs on MANUAL rollback of a
        // fully-dispatched plan, never inside a forward saga since this is last).
        compensate: async () => ({ reverted: 'workflow_dispatch_reversal_flagged', requires_manual_review: true }),
    },
};

let stepHandlers = { ...DEFAULT_STEP_HANDLERS };
function registerStepHandler(name, handler) {
    if (!handler || typeof handler.execute !== 'function') {
        throw new AppError('VALIDATION', 'step handler requires an execute() function', 422);
    }
    stepHandlers = { ...stepHandlers, [name]: handler };
}
function resetStepHandlers() { stepHandlers = { ...DEFAULT_STEP_HANDLERS }; }

/** Drive a workflow forward to DISPATCHED (FREIGHT_BOOKED → DISPATCH_READY → DISPATCHED). */
async function driveWorkflowToDispatched(workflowId, { actor = 'system' } = {}) {
    const wf = workflowEngine();
    if (!wf) return { skipped: true, reason: 'no_workflow_engine' };
    const transitions = [];
    let guard = 0;
    // advance() resolves the canonical forward event for the current state; cap
    // iterations so a misconfigured machine can never spin.
    while (guard < 4) {
        guard += 1;
        let current;
        try {
            const wfRow = await db.ShipmentWorkflow.findByPk(workflowId);
            if (!wfRow) return { skipped: true, reason: 'workflow_not_found', transitions };
            current = wfRow.current_state;
        } catch {
            return { skipped: true, reason: 'workflow_unreadable', transitions };
        }
        if (current === 'DISPATCHED' || current === 'IN_TRANSIT' || current === 'DELIVERED' || current === 'COMPLETED') {
            return { reached: current, transitions };
        }
        if (current !== 'FREIGHT_BOOKED' && current !== 'DISPATCH_READY') {
            // Not in a position the dispatch step can advance — surface, don't force.
            return { reached: current, transitions, note: 'workflow_not_at_freight_booked' };
        }
        const res = await wf.advance(workflowId, { actor, source: 'dispatch_engine' });
        transitions.push({ event: res.transition.event, to: res.transition.to_state });
        if (res.workflow.current_state === 'DISPATCHED') return { reached: 'DISPATCHED', transitions };
    }
    return { reached: 'unknown', transitions };
}

// ── Webhook fan-out ──────────────────────────────────────────────────────────

/** Signed JSON body delivered to dispatch webhook subscribers. */
function buildEventPayload(plan, eventType, extra = {}) {
    return {
        type: `dispatch.${eventType}`,
        plan_id: plan.id,
        reference_no: plan.reference_no,
        status: plan.status,
        workflow_id: plan.workflow_id || null,
        shipment_id: plan.shipment_id || null,
        trade_operation_id: plan.trade_operation_id || null,
        tenant_id: plan.tenant_id,
        occurred_at: nowIso(),
        ...extra,
    };
}

/**
 * Build delivery rows for matching subscriptions and enqueue them (post-commit).
 * Best-effort: a fan-out failure never breaks the dispatch flow.
 */
async function fanOut(plan, eventType, extra = {}) {
    if (!db.DispatchWebhook || !db.DispatchWebhookDelivery) return { enqueued: 0 };
    let subs = [];
    try {
        // `withSecret` scope exposes the signing secret while still honouring paranoid
        // (no soft-deleted subs) + the tenant filter below.
        subs = await db.DispatchWebhook.scope('withSecret').findAll({
            where: { tenant_id: plan.tenant_id, active: true },
        });
    } catch { return { enqueued: 0 }; }
    if (!subs.length) return { enqueued: 0 };

    const tags = [eventType, `status:${plan.status}`];
    const payload = buildEventPayload(plan, eventType, extra);
    const deliveries = [];
    for (const sub of subs) {
        const filters = Array.isArray(sub.event_filters) ? sub.event_filters : [];
        const matches = filters.length === 0 || filters.some((f) => tags.includes(f));
        if (!matches) continue;
        try {
            const delivery = await db.DispatchWebhookDelivery.create({
                tenant_id: plan.tenant_id,
                webhook_id: sub.id,
                plan_id: plan.id,
                event_type: eventType,
                status: 'pending',
                payload,
            });
            deliveries.push({ deliveryId: delivery.id, tenantId: plan.tenant_id, url: sub.url, secret: sub.secret, payload });
        } catch { /* skip this subscription, keep going */ }
    }
    if (!deliveries.length) return { enqueued: 0 };
    return webhookDispatcher().enqueueDeliveries(deliveries);
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a dispatch orchestration plan.
 * @param {object} input
 * @param {string} [input.tenantId]
 * @param {string} [input.workflowId]          link to a shipment workflow (enables auto-advance)
 * @param {string} [input.shipmentId]
 * @param {string} [input.tradeOperationId]
 * @param {string} [input.reference]
 * @param {object} [input.rule]                 loose rule config (mode/required/threshold/manual_hold)
 * @param {boolean} [input.autoDispatch=true]   fire automatically when the rule is satisfied
 * @param {object} [input.conditions]           pre-seed already-met gates { condition: true|{...} }
 * @param {object} [input.metadata]
 * @param {string} [input.actor]
 */
async function createPlan(input = {}) {
    const rule = schema.ruleConfig(input.rule || {});
    let conditions = schema.emptyConditionState(rule.required);

    // Optional pre-seed (e.g. a plan created mid-flight after some gates passed).
    if (input.conditions && typeof input.conditions === 'object') {
        for (const [cond, val] of Object.entries(input.conditions)) {
            if (!schema.isCondition(cond)) continue;
            const slot = val === true ? { met: true } : (val || {});
            conditions = ruleEngine.applySignal(conditions, cond, {
                met: slot.met !== undefined ? slot.met : true,
                source: slot.source || 'seed',
                detail: slot.detail || {},
                at: nowIso(),
            });
        }
    }

    const decision = ruleEngine.evaluate(conditions, rule);
    const status = decision.decision === 'dispatch' ? STATUS.READY : STATUS.PENDING;

    const plan = await db.DispatchPlan.create({
        ...(input.tenantId ? { tenant_id: input.tenantId } : {}),
        reference_no: input.reference || newReference(),
        workflow_id: input.workflowId || null,
        shipment_id: input.shipmentId || null,
        trade_operation_id: input.tradeOperationId || null,
        auto_dispatch: input.autoDispatch !== false,
        rule,
        conditions,
        dispatch_steps: [],
        status,
        version: 1,
        engine_version: schema.ENGINE_VERSION,
        metadata: input.metadata || {},
        created_by: input.actor || null,
        updated_by: input.actor || null,
    });
    await appendEvent(plan, { eventType: EVENT_TYPE.CREATED, message: `plan created (${status})`, detail: { rule, readiness: decision }, actor: input.actor });

    // If pre-seeded straight to ready + auto-dispatch, fire now.
    if (status === STATUS.READY && plan.auto_dispatch) {
        await fanOut(plan, 'ready', { readiness: decision });
        await triggerDispatch(plan.id, { actor: input.actor || 'system', tenantId: plan.tenant_id, auto: true }).catch(() => {});
    }
    return { record: plan, view: toView(plan) };
}

// ── Signal a condition (the generic event entry point) ───────────────────────

/**
 * Record a gate signal, re-evaluate the rule, and auto-dispatch if it flips to
 * satisfied. Idempotent per (plan, idempotencyKey). Locks the plan row.
 */
async function signalCondition(planId, condition, opts = {}) {
    const { met = true, source = 'api', detail = {}, actor = null, idempotencyKey = null } = opts;
    if (!schema.isCondition(condition)) {
        throw new AppError('UNKNOWN_CONDITION', `Unknown dispatch condition: ${condition}`, 422, { condition, valid: schema.ALL_CONDITIONS });
    }

    let fired = null;
    const result = await db.sequelize.transaction(async (t) => {
        const plan = await db.DispatchPlan.findByPk(planId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!plan) throw new AppError('NOT_FOUND', 'Dispatch plan not found', 404);

        // Idempotency: a prior signal under the same key wins, unchanged.
        if (idempotencyKey) {
            const existing = await db.DispatchEvent.findOne({
                where: { plan_id: planId, idempotency_key: idempotencyKey },
                transaction: t,
            });
            if (existing) return { plan, decision: ruleEngine.evaluate(plan.conditions || {}, plan.rule || {}), idempotent: true };
        }

        if (schema.isTerminal(plan.status)) {
            // Record the late signal for audit but do not mutate a terminal plan.
            await appendEvent(plan, { eventType: EVENT_TYPE.CONDITION_SIGNAL, condition, message: `late signal on ${plan.status} plan`, detail: { met, source, ignored: true }, actor, idempotencyKey }, t);
            return { plan, decision: ruleEngine.evaluate(plan.conditions || {}, plan.rule || {}), idempotent: false, ignored: true };
        }

        const before = plan.status;
        const nextConditions = ruleEngine.applySignal(plan.conditions || {}, condition, { met, source, detail, at: nowIso() });
        const decision = ruleEngine.evaluate(nextConditions, plan.rule || {});

        plan.conditions = nextConditions;
        plan.changed('conditions', true);
        plan.version = (plan.version || 1) + 1;
        plan.updated_by = actor;
        if (before === STATUS.PENDING && decision.decision === 'dispatch') plan.status = STATUS.READY;
        // A new "unmet" signal can never demote a ready plan back here — readiness
        // only moves forward into the dispatch saga; un-readiness is an ops concern.
        await plan.save({ transaction: t });

        await appendEvent(plan, { eventType: EVENT_TYPE.CONDITION_SIGNAL, condition, message: `${condition} = ${met}`, detail: { met, source }, actor, idempotencyKey }, t);
        await appendEvent(plan, { eventType: EVENT_TYPE.EVALUATED, message: `decision: ${decision.decision} (${decision.metCount}/${decision.requiredCount})`, detail: decision, actor }, t);

        if (before === STATUS.PENDING && plan.status === STATUS.READY) fired = { ready: true, decision };
        return { plan, decision, idempotent: false };
    });

    // ── Post-commit fan-out + auto-dispatch (best-effort). ──
    if (!result.idempotent && !result.ignored) {
        await fanOut(result.plan, 'condition_signal', { condition, met, decision: result.decision }).catch(() => {});
        if (fired && fired.ready) {
            await fanOut(result.plan, 'ready', { readiness: result.decision }).catch(() => {});
            if (result.plan.auto_dispatch && !result.decision.held) {
                await triggerDispatch(planId, { actor: actor || 'system', tenantId: result.plan.tenant_id, auto: true }).catch(() => {});
            }
        }
    }

    const fresh = await db.DispatchPlan.findByPk(planId);
    return { record: fresh, view: toView(fresh), decision: result.decision, idempotent: !!result.idempotent };
}

/**
 * EVENT TRIGGER bridge — called by the workflow engine post-commit. Maps a
 * workflow transition into a gate signal against the plan attached to that
 * workflow. Returns null (silently) when the transition isn't a gate or no plan
 * is attached. Idempotent on the transition id. Best-effort by contract.
 */
async function onWorkflowTransition(workflowRow, transition, opts = {}) {
    if (!db.DispatchPlan) return null;
    const toState = transition && transition.to_state;
    const condition = schema.conditionForWorkflowState(toState);
    if (!condition) return null; // not a gating transition

    const tenantId = (workflowRow && workflowRow.tenant_id) || opts.tenantId || null;
    let plan;
    try {
        const where = { workflow_id: workflowRow.id };
        if (tenantId) where.tenant_id = tenantId;
        // Plain find honours paranoid (no soft-deleted plans); explicit tenant_id
        // scopes correctly under both the tenant hook and an admin bypass.
        plan = await db.DispatchPlan.findOne({ where, order: [['created_at', 'DESC']] });
    } catch { return null; }
    if (!plan) return null; // no orchestration plan for this workflow

    return signalCondition(plan.id, condition, {
        met: true,
        source: 'workflow',
        detail: { event: transition.event, from: transition.from_state, to: transition.to_state, transition_id: transition.id },
        actor: opts.actor || 'system',
        idempotencyKey: `wf:${transition.id}`,
    }).catch(() => null);
}

// ── Trigger the dispatch saga ────────────────────────────────────────────────

/**
 * Fire (or force) the dispatch saga for a plan. Reserves the plan (status →
 * dispatching, version bump) in one txn, then runs the compensating saga and
 * finalizes the resting state. Idempotent: a plan already dispatching/dispatched
 * is not re-run.
 */
async function triggerDispatch(planId, opts = {}) {
    const { actor = 'system', force = false, tenantId = null, simulate = null, auto = false } = opts;

    // ── Reserve: lock + validate + flip to dispatching in one txn. ──
    const reserved = await db.sequelize.transaction(async (t) => {
        const plan = await db.DispatchPlan.findByPk(planId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!plan) throw new AppError('NOT_FOUND', 'Dispatch plan not found', 404);
        if (tenantId && plan.tenant_id !== tenantId) throw new AppError('NOT_FOUND', 'Dispatch plan not found', 404);

        if (plan.status === STATUS.DISPATCHED) return { plan, alreadyDone: true };
        if (plan.status === STATUS.DISPATCHING) throw new AppError('IN_PROGRESS', 'Dispatch already in progress', 409);
        if (plan.status === STATUS.CANCELLED) throw new AppError('CANCELLED', 'Dispatch plan is cancelled', 409);

        const decision = ruleEngine.evaluate(plan.conditions || {}, plan.rule || {});
        if (!decision.satisfied && !force) {
            throw new AppError('NOT_READY', 'Dispatch conditions are not satisfied', 409, { missing: decision.missing, met: decision.met });
        }
        if (decision.held && !force) {
            throw new AppError('ON_HOLD', 'Dispatch is on manual hold', 409, { decision });
        }

        plan.status = STATUS.DISPATCHING;
        plan.failure_reason = null;
        plan.version = (plan.version || 1) + 1;
        plan.updated_by = actor;
        await plan.save({ transaction: t });
        await appendEvent(plan, { eventType: EVENT_TYPE.DISPATCH_STARTED, message: force ? 'dispatch forced' : (auto ? 'auto-dispatch' : 'dispatch requested'), detail: { decision, force, auto }, actor }, t);
        return { plan, alreadyDone: false };
    });

    if (reserved.alreadyDone) {
        const fresh = await db.DispatchPlan.findByPk(planId);
        return { record: fresh, view: toView(fresh), idempotent: true };
    }

    // ── Run the saga OUTSIDE the reserve txn (multi-step external effects). ──
    const plan = reserved.plan;
    const ctx = { plan, planId: plan.id, tenantId: plan.tenant_id, actor, simulate };
    const steps = schema.DEFAULT_DISPATCH_STEPS
        .filter((name) => stepHandlers[name])
        .map((name) => ({
            name,
            execute: (c) => stepHandlers[name].execute(c),
            compensate: stepHandlers[name].compensate ? (c, r) => stepHandlers[name].compensate(c, r) : undefined,
        }));

    const hooks = {
        onStepDone: ({ step, result }) => appendEvent(plan, { eventType: EVENT_TYPE.STEP_COMPLETED, step, message: `step ${step} ok`, detail: { result }, actor }),
        onStepFail: ({ step, error }) => appendEvent(plan, { eventType: EVENT_TYPE.STEP_FAILED, step, message: `step ${step} failed`, detail: { error: String((error && error.message) || error) }, actor }),
        onRollbackStart: ({ failedStep, completed }) => appendEvent(plan, { eventType: EVENT_TYPE.ROLLBACK_STARTED, step: failedStep, message: `rolling back ${completed.length} step(s)`, detail: { completed }, actor }),
        onCompensateDone: ({ step }) => appendEvent(plan, { eventType: EVENT_TYPE.STEP_COMPENSATED, step, message: `compensated ${step}`, actor }),
        onCompensateFail: ({ step, error }) => appendEvent(plan, { eventType: EVENT_TYPE.COMPENSATE_FAILED, step, message: `compensation failed for ${step}`, detail: { error: String((error && error.message) || error) }, actor }),
    };

    const outcome = await saga.runSaga(steps, ctx, hooks);

    // ── Finalize the resting state. ──
    let webhookEvent;
    if (outcome.ok) {
        plan.status = STATUS.DISPATCHED;
        plan.dispatch_steps = outcome.completed.map((c) => c.name);
        plan.dispatched_at = new Date();
        plan.failure_reason = null;
        webhookEvent = 'dispatched';
    } else if (outcome.rolledBack) {
        plan.status = STATUS.ROLLED_BACK;
        plan.dispatch_steps = [];
        plan.rolled_back_at = new Date();
        plan.failure_reason = `step '${outcome.failedStep}' failed: ${outcome.error}`;
        webhookEvent = 'rolled_back';
    } else {
        plan.status = STATUS.FAILED;
        plan.dispatch_steps = outcome.completed;
        plan.failure_reason = `step '${outcome.failedStep}' failed: ${outcome.error}; compensation incomplete`;
        webhookEvent = 'failed';
    }
    plan.version = (plan.version || 1) + 1;
    plan.updated_by = actor;
    await plan.save();
    await appendEvent(plan, {
        eventType: outcome.ok ? EVENT_TYPE.DISPATCHED : (outcome.rolledBack ? EVENT_TYPE.ROLLED_BACK : EVENT_TYPE.FAILED),
        message: outcome.ok ? 'dispatch completed' : (outcome.rolledBack ? 'dispatch failed — rolled back cleanly' : 'dispatch failed — compensation incomplete'),
        detail: outcome.ok ? { steps: plan.dispatch_steps } : { failedStep: outcome.failedStep, error: outcome.error, compensationErrors: outcome.compensationErrors },
        actor,
    });
    await fanOut(plan, webhookEvent, outcome.ok ? { steps: plan.dispatch_steps } : { failedStep: outcome.failedStep }).catch(() => {});

    const fresh = await db.DispatchPlan.findByPk(planId);
    return { record: fresh, view: toView(fresh), outcome };
}

// ── Manual rollback of a dispatched plan ─────────────────────────────────────

/** Compensate a fully-dispatched plan (operator reversal). */
async function rollback(planId, { actor = 'system', tenantId = null, reason = null } = {}) {
    const where = { id: planId };
    if (tenantId) where.tenant_id = tenantId;
    const plan = await db.DispatchPlan.findOne({ where });
    if (!plan) throw new AppError('NOT_FOUND', 'Dispatch plan not found', 404);
    if (plan.status !== STATUS.DISPATCHED) {
        throw new AppError('NOT_DISPATCHED', `Only a dispatched plan can be rolled back (status '${plan.status}')`, 409);
    }

    await appendEvent(plan, { eventType: EVENT_TYPE.ROLLBACK_STARTED, message: reason || 'manual rollback', detail: { steps: plan.dispatch_steps || [] }, actor });
    const ctx = { plan, planId: plan.id, tenantId: plan.tenant_id, actor };
    // Rebuild the completed-step records (no execute results retained) in order.
    const completed = (plan.dispatch_steps || [])
        .filter((name) => stepHandlers[name])
        .map((name) => ({ step: { name, compensate: stepHandlers[name].compensate }, result: {} }));
    const { compensated, compensationErrors } = await saga.compensate(completed, ctx, {
        onCompensateDone: ({ step }) => appendEvent(plan, { eventType: EVENT_TYPE.STEP_COMPENSATED, step, message: `compensated ${step}`, actor }),
        onCompensateFail: ({ step, error }) => appendEvent(plan, { eventType: EVENT_TYPE.COMPENSATE_FAILED, step, message: `compensation failed for ${step}`, detail: { error: String((error && error.message) || error) }, actor }),
    });

    plan.status = STATUS.ROLLED_BACK;
    plan.rolled_back_at = new Date();
    plan.failure_reason = reason || 'manual rollback';
    plan.dispatch_steps = [];
    plan.version = (plan.version || 1) + 1;
    plan.updated_by = actor;
    await plan.save();
    await appendEvent(plan, { eventType: EVENT_TYPE.ROLLED_BACK, message: 'rolled back', detail: { compensated, compensationErrors }, actor });
    await fanOut(plan, 'rolled_back', { compensated }).catch(() => {});
    return { record: plan, view: toView(plan), compensated, compensationErrors };
}

/** Re-drive a failed / rolled-back plan: reset to its rule-evaluated state then dispatch. */
async function retryDispatch(planId, { actor = 'system', tenantId = null, force = false } = {}) {
    const where = { id: planId };
    if (tenantId) where.tenant_id = tenantId;
    const plan = await db.DispatchPlan.findOne({ where });
    if (!plan) throw new AppError('NOT_FOUND', 'Dispatch plan not found', 404);
    if (!schema.RECOVERABLE_STATUSES.includes(plan.status) && plan.status !== STATUS.READY) {
        throw new AppError('NOT_RETRYABLE', `Plan in status '${plan.status}' cannot be retried`, 409);
    }
    const decision = ruleEngine.evaluate(plan.conditions || {}, plan.rule || {});
    plan.status = decision.decision === 'dispatch' ? STATUS.READY : STATUS.PENDING;
    plan.failure_reason = null;
    plan.version = (plan.version || 1) + 1;
    plan.updated_by = actor;
    await plan.save();
    await appendEvent(plan, { eventType: EVENT_TYPE.RETRY, message: 'manual retry', detail: { decision }, actor });
    if (plan.status === STATUS.READY || force) {
        return triggerDispatch(planId, { actor, tenantId, force });
    }
    return { record: plan, view: toView(plan), decision };
}

/** Cancel a non-terminal plan. */
async function cancel(planId, { actor = 'system', tenantId = null, reason = null } = {}) {
    const where = { id: planId };
    if (tenantId) where.tenant_id = tenantId;
    const plan = await db.DispatchPlan.findOne({ where });
    if (!plan) throw new AppError('NOT_FOUND', 'Dispatch plan not found', 404);
    if (schema.isTerminal(plan.status)) throw new AppError('ALREADY_TERMINAL', `Plan already '${plan.status}'`, 409);
    if (plan.status === STATUS.DISPATCHING) throw new AppError('IN_PROGRESS', 'Cannot cancel a dispatch in progress', 409);
    plan.status = STATUS.CANCELLED;
    plan.version = (plan.version || 1) + 1;
    plan.updated_by = actor;
    await plan.save();
    await appendEvent(plan, { eventType: EVENT_TYPE.CANCELLED, message: reason || 'cancelled', actor });
    await fanOut(plan, 'cancelled', {}).catch(() => {});
    return { record: plan, view: toView(plan) };
}

// ── Read paths ───────────────────────────────────────────────────────────────

async function getPlan(planId, { tenantId = null } = {}) {
    const where = { id: planId };
    if (tenantId) where.tenant_id = tenantId;
    const row = await db.DispatchPlan.findOne({ where });
    if (!row) throw new AppError('NOT_FOUND', 'Dispatch plan not found', 404);
    return row;
}

async function listPlans({ tenantId = null, status = null, workflowId = null, shipmentId = null, page = 1, limit = 20 } = {}) {
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const where = {};
    if (tenantId) where.tenant_id = tenantId;
    if (status) where.status = status;
    if (workflowId) where.workflow_id = workflowId;
    if (shipmentId) where.shipment_id = shipmentId;
    const { count, rows } = await db.DispatchPlan.findAndCountAll({
        where, limit: l, offset: (p - 1) * l, order: [['created_at', 'DESC']],
    });
    return { items: rows, total: count, page: p, limit: l, pages: Math.ceil(count / l) || 0 };
}

async function listEvents(planId, { tenantId = null, limit = 200 } = {}) {
    if (!db.DispatchEvent) return [];
    const where = { plan_id: planId };
    if (tenantId) where.tenant_id = tenantId;
    return db.DispatchEvent.findAll({
        where, order: [['seq', 'ASC']], limit: Math.min(1000, Math.max(1, Number(limit) || 200)),
    });
}

module.exports = {
    createPlan,
    signalCondition,
    onWorkflowTransition,
    triggerDispatch,
    rollback,
    retryDispatch,
    cancel,
    getPlan,
    listPlans,
    listEvents,
    toView,
    buildEventPayload,
    fanOut,
    newReference,
    registerStepHandler,
    resetStepHandlers,
    driveWorkflowToDispatched,
    DEFAULT_STEP_HANDLERS,
};
