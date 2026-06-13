'use strict';
/**
 * Shipment Workflow ENGINE (War Room 4, Prompt 2).
 *
 * Wraps the pure state machine (stateMachine.js) with persistence and the four
 * production guarantees the prompt asks for:
 *
 *   • Event-driven      — every state change is an applied `event`; nothing
 *                         mutates current_state except dispatch().
 *   • Idempotency        — (workflow_id, idempotency_key) is UNIQUE; a replayed
 *                         dispatch returns the already-recorded transition.
 *   • Retry-safe         — dispatch runs in one transaction; SELECT … FOR UPDATE
 *                         serialises concurrent calls on the same workflow, and
 *                         the optimistic `version` column is a second guard. A
 *                         crash before commit leaves NO partial state.
 *   • Invalid blocking   — decide() rejects illegal/terminal transitions before
 *                         any write happens.
 *
 * Webhooks are fanned out AFTER commit so a subscriber never observes a
 * transition that later rolled back. Delivery rows are written inside the
 * transaction (auditable) and enqueued to the retry-safe `workflow_webhook`
 * queue post-commit.
 */
const crypto = require('crypto');
const db = require('../../models');
const sm = require('./stateMachine');
const { AppError } = require('../../utils/errors');

let dispatcher = null; // lazy require to avoid a require cycle through queue/workers
function webhookDispatcher() {
    if (!dispatcher) dispatcher = require('./webhookDispatcher');
    return dispatcher;
}

let readiness = null; // lazy require to avoid a require cycle through the engine
function readinessEngine() {
    if (!readiness) {
        try { readiness = require('../readiness/readinessEngine'); }
        catch { readiness = { triggerRecalc: async () => null }; }
    }
    return readiness;
}

let compliance = null; // lazy require — the compliance screening engine (Prompt 8)
function complianceEngine() {
    if (!compliance) {
        try { compliance = require('../compliance/complianceEngine'); }
        catch { compliance = { triggerScreen: async () => null }; }
    }
    return compliance;
}

let dispatchOrch = null; // lazy require — the dispatch orchestration engine (Prompt 11)
function dispatchEngine() {
    if (!dispatchOrch) {
        try { dispatchOrch = require('../dispatch/dispatchEngine'); }
        catch { dispatchOrch = { onWorkflowTransition: async () => null }; }
    }
    return dispatchOrch;
}

function newReference() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `WF-${ts}-${rand}`;
}

/** Create a new workflow instance in the INITIAL_STATE (CREATED). */
async function createWorkflow({ tenantId, shipmentId = null, tradeOperationId = null, reference = null, metadata = {}, actor = null }) {
    const workflow = await db.ShipmentWorkflow.create({
        tenant_id: tenantId,
        reference_no: reference || newReference(),
        shipment_id: shipmentId,
        trade_operation_id: tradeOperationId,
        current_state: sm.INITIAL_STATE,
        status: sm.statusForState(sm.INITIAL_STATE),
        metadata: metadata || {},
        created_by: actor,
        updated_by: actor,
    });
    return workflow;
}

/** Compute the webhook match tags for a transition. */
function transitionTags(transition, status) {
    return [transition.event, `entered:${transition.to_state}`, `status:${status}`];
}

/**
 * Dispatch an event against a workflow. The core transition primitive.
 *
 * @returns {{ workflow, transition, idempotent: boolean, allowedEvents: string[] }}
 */
async function dispatch(workflowId, event, opts = {}) {
    const { idempotencyKey = null, actor = null, source = 'api', reason = null, payload = {} } = opts;

    if (!sm.isEvent(event)) {
        // Fail fast with the allowed-events hint BEFORE opening a transaction.
        throw new AppError('UNKNOWN_EVENT', `Unknown workflow event: ${event}`, 422, { event, validEvents: sm.EVENTS });
    }

    // Side effects to run only after a successful commit.
    let postCommit = [];

    const result = await db.sequelize.transaction(async (t) => {
        // SELECT … FOR UPDATE — serialise concurrent dispatches on this workflow.
        const workflow = await db.ShipmentWorkflow.findByPk(workflowId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!workflow) throw new AppError('NOT_FOUND', 'Workflow not found', 404);

        // ── Idempotency: a prior transition under the same key wins, unchanged. ──
        if (idempotencyKey) {
            const existing = await db.WorkflowTransition.findOne({
                where: { workflow_id: workflowId, idempotency_key: idempotencyKey },
                transaction: t,
            });
            if (existing) {
                return { workflow, transition: existing, idempotent: true };
            }
        }

        // ── Pure decision — invalid / terminal transitions are blocked here. ──
        const decision = sm.decide(workflow.current_state, event);
        if (!decision.ok) {
            const statusCode = decision.code === 'INVALID_TRANSITION' || decision.code === 'TERMINAL_STATE' ? 409 : 422;
            throw new AppError(decision.code, decision.message, statusCode, {
                from: decision.from,
                event,
                allowedEvents: decision.allowed,
            });
        }

        const nextStatus = sm.statusForState(decision.to);
        const seq = (await db.WorkflowTransition.count({ where: { workflow_id: workflowId }, transaction: t })) + 1;

        // Append the immutable event-log row.
        const transition = await db.WorkflowTransition.create({
            tenant_id: workflow.tenant_id,
            workflow_id: workflow.id,
            seq,
            event,
            from_state: decision.from,
            to_state: decision.to,
            idempotency_key: idempotencyKey,
            actor,
            source,
            reason,
            payload: payload || {},
            occurred_at: new Date(),
        }, { transaction: t });

        // Advance the aggregate (optimistic `version` bumps on save).
        workflow.current_state = decision.to;
        workflow.status = nextStatus;
        workflow.last_event = event;
        workflow.last_transition_at = transition.occurred_at;
        workflow.updated_by = actor;
        if (decision.event === 'fail') workflow.failure_reason = reason || 'unspecified';
        if (decision.event === 'reject_documents') workflow.retry_count = (workflow.retry_count || 0) + 1;
        await workflow.save({ transaction: t });

        // ── Build webhook delivery rows for matching subscriptions (audit trail). ──
        const tags = transitionTags(transition, nextStatus);
        const subs = await db.WorkflowWebhook.unscoped().findAll({
            where: { tenant_id: workflow.tenant_id, active: true },
            transaction: t,
        });
        for (const sub of subs) {
            const filters = Array.isArray(sub.event_filters) ? sub.event_filters : [];
            const matches = filters.length === 0 || filters.some((f) => tags.includes(f));
            if (!matches) continue;

            const eventPayload = buildEventPayload(workflow, transition);
            const delivery = await db.WorkflowWebhookDelivery.create({
                tenant_id: workflow.tenant_id,
                webhook_id: sub.id,
                workflow_id: workflow.id,
                transition_id: transition.id,
                event,
                status: 'pending',
                payload: eventPayload,
            }, { transaction: t });

            postCommit.push({ deliveryId: delivery.id, tenantId: workflow.tenant_id, url: sub.url, secret: sub.secret, payload: eventPayload });
        }

        return { workflow, transition, idempotent: false };
    });

    // ── Fan out AFTER commit (skip for an idempotent replay — already delivered). ──
    if (!result.idempotent && postCommit.length) {
        await webhookDispatcher().enqueueDeliveries(postCommit);
    }

    // ── Event-triggered readiness recalculation (best-effort, post-commit). ──
    // A real transition changed compliance progress (and possibly risk), so the
    // shipment's readiness score must be refreshed. Never throws into this path.
    if (!result.idempotent && result.workflow.shipment_id) {
        await readinessEngine().triggerRecalc(result.workflow.shipment_id, {
            trigger: 'workflow_transition',
            reason: `workflow ${event}: ${result.transition.from_state} → ${result.transition.to_state}`,
            actor: actor || 'system',
            tenantId: result.workflow.tenant_id,
        });
    }

    // ── Event-triggered compliance screening (best-effort, post-commit). ──
    // Entering COMPLIANCE_CHECK is exactly when the operation's sanctions / export-
    // control posture should be (re)screened. Fire-and-forget — a screening failure
    // must never break or roll back the workflow transition.
    //
    // This is ADVISORY, not an automatic hard gate: it persists a compliance_screenings
    // snapshot (including a `block` decision) but does NOT itself advance/halt the
    // workflow. The genuine gate is the MANUAL `clear_compliance` event — an operator
    // / UI reads the latest screening (GET /v1/compliance_screening/operations/:id) and
    // only fires `clear_compliance` to leave COMPLIANCE_CHECK once the decision is clear
    // (or a reviewed override is recorded). A `block` is therefore surfaced for action,
    // never silently auto-cleared.
    if (!result.idempotent && result.transition.to_state === sm.STATES.COMPLIANCE_CHECK && result.workflow.trade_operation_id) {
        await complianceEngine().triggerScreen(result.workflow.trade_operation_id, {
            trigger: 'workflow_transition',
            reason: `entered COMPLIANCE_CHECK via ${event}`,
            actor: actor || 'system',
            tenantId: result.workflow.tenant_id,
            shipmentId: result.workflow.shipment_id || null,
        });
    }

    // ── Event-triggered dispatch orchestration (best-effort, post-commit). ──
    // A transition into COMPLIANCE_CHECK / HS_CLASSIFICATION / CUSTOMS_READY /
    // FREIGHT_BOOKED signals one of the four dispatch gates (documents validated /
    // compliance passed / customs ready / freight booked). The dispatch engine maps
    // the transition to a gate signal on the plan attached to this workflow and, when
    // all required gates have cleared, fires the dispatch saga automatically. Silent
    // no-op when no plan is attached; never throws into the transition path.
    if (!result.idempotent) {
        await dispatchEngine().onWorkflowTransition(result.workflow, result.transition, {
            actor: actor || 'system',
            tenantId: result.workflow.tenant_id,
        }).catch(() => null);
    }

    return {
        workflow: result.workflow,
        transition: result.transition,
        idempotent: result.idempotent,
        allowedEvents: sm.allowedEvents(result.workflow.current_state),
    };
}

/** The signed JSON body delivered to webhook subscribers. */
function buildEventPayload(workflow, transition) {
    return {
        type: `shipment_workflow.${transition.event}`,
        workflow_id: workflow.id,
        reference_no: workflow.reference_no,
        shipment_id: workflow.shipment_id,
        trade_operation_id: workflow.trade_operation_id,
        from_state: transition.from_state,
        to_state: transition.to_state,
        status: workflow.status,
        seq: transition.seq,
        occurred_at: transition.occurred_at,
        tenant_id: workflow.tenant_id,
    };
}

/** Advance a workflow one canonical step forward (no-branch convenience). */
async function advance(workflowId, opts = {}) {
    const workflow = await db.ShipmentWorkflow.findByPk(workflowId);
    if (!workflow) throw new AppError('NOT_FOUND', 'Workflow not found', 404);
    const event = sm.FORWARD_EVENT_BY_STATE[workflow.current_state];
    if (!event) {
        throw new AppError('NO_FORWARD_TRANSITION', `No forward transition from state '${workflow.current_state}'`, 409, {
            from: workflow.current_state,
            allowedEvents: sm.allowedEvents(workflow.current_state),
        });
    }
    return dispatch(workflowId, event, { ...opts, source: opts.source || 'api' });
}

module.exports = {
    createWorkflow,
    dispatch,
    advance,
    buildEventPayload,
    newReference,
};
