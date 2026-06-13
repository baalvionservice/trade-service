'use strict';
// Shipment Workflow State Machine — HTTP surface (War Room 4, Prompt 2).
// Thin controller: validation + tenant ownership + delegation to the engine.
const db = require('../models');
const sm = require('../service/workflow/stateMachine');
const engine = require('../service/workflow/workflowEngine');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || [];
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}
function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}
function actorOf(req) {
    return (req.auth && (req.auth.userId || req.auth.email)) || 'system';
}

async function fetchWorkflowOwned(id, req, next) {
    const workflow = await db.ShipmentWorkflow.findByPk(id);
    if (!workflow) { next(new AppError('NOT_FOUND', 'Workflow not found', 404)); return null; }
    if (isAdmin(req)) return workflow;
    const tenantId = callerTenantId(req);
    if (tenantId && workflow.tenant_id && workflow.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Workflow not found', 404)); return null;
    }
    return workflow;
}

function workflowView(workflow) {
    return {
        ...(workflow.toJSON ? workflow.toJSON() : workflow),
        allowed_events: sm.allowedEvents(workflow.current_state),
        next_forward_state: sm.nextForwardState(workflow.current_state),
        is_terminal: sm.isTerminal(workflow.current_state),
    };
}

// ── Definition: expose the state machine for clients / UI. ───────────────────
const getDefinition = (req, res) => sendSuccess(req, res, {
    states: sm.ALL_STATES,
    initial_state: sm.INITIAL_STATE,
    terminal_states: sm.TERMINAL_STATES,
    events: sm.EVENTS,
    transitions: Object.entries(sm.TRANSITIONS).map(([event, t]) => ({
        event, from: t.from, to: t.to, kind: t.kind,
    })),
});

// ── Create ───────────────────────────────────────────────────────────────────
const createWorkflow = async (req, res, next) => {
    try {
        const tenantId = callerTenantId(req);
        if (!tenantId && !isAdmin(req)) return next(new AppError('TENANT_REQUIRED', 'No tenant context', 400));
        const { shipment_id = null, trade_operation_id = null, reference_no = null, metadata = {} } = req.body || {};

        // If bound to a shipment, ensure it exists in the caller's tenant (and
        // enforce the one-workflow-per-shipment unique index proactively).
        if (shipment_id) {
            const shipment = await db.TradeShipment.findByPk(shipment_id);
            if (!shipment) return next(new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found', 404));
            const existing = await db.ShipmentWorkflow.findOne({ where: { shipment_id } });
            if (existing) return next(new AppError('WORKFLOW_EXISTS', 'A workflow already exists for this shipment', 409, { workflow_id: existing.id }));
        }

        const workflow = await engine.createWorkflow({
            tenantId: tenantId || (req.body && req.body.tenant_id) || 'T-DEMO',
            shipmentId: shipment_id,
            tradeOperationId: trade_operation_id,
            reference: reference_no,
            metadata,
            actor: actorOf(req),
        });
        return sendSuccess(req, res, workflowView(workflow), 201);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return next(new AppError('DUPLICATE', 'A workflow with that reference or shipment already exists', 409));
        }
        return next(err);
    }
};

// ── List ───────────────────────────────────────────────────────────────────
const listWorkflows = async (req, res, next) => {
    try {
        const { state, status, shipment_id, trade_operation_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (state) where.current_state = state;
        if (status) where.status = status;
        if (shipment_id) where.shipment_id = shipment_id;
        if (trade_operation_id) where.trade_operation_id = trade_operation_id;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.ShipmentWorkflow.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, {
            items: rows.map(workflowView), total: count, page: Number(page), limit: Number(limit),
        });
    } catch (err) {
        return next(err);
    }
};

// ── Detail ───────────────────────────────────────────────────────────────────
const getWorkflow = async (req, res, next) => {
    try {
        const workflow = await fetchWorkflowOwned(req.params.id, req, next);
        if (!workflow) return undefined;
        return sendSuccess(req, res, workflowView(workflow));
    } catch (err) {
        return next(err);
    }
};

// ── Event log (append-only transition history) ──────────────────────────────
const listTransitions = async (req, res, next) => {
    try {
        const workflow = await fetchWorkflowOwned(req.params.id, req, next);
        if (!workflow) return undefined;
        const rows = await db.WorkflowTransition.findAll({
            where: { workflow_id: workflow.id }, order: [['seq', 'ASC']],
        });
        return sendSuccess(req, res, rows);
    } catch (err) {
        return next(err);
    }
};

// ── Dispatch an event (the core transition endpoint) ─────────────────────────
const dispatchEvent = async (req, res, next) => {
    try {
        const workflow = await fetchWorkflowOwned(req.params.id, req, next);
        if (!workflow) return undefined;
        const { event, reason = null, payload = {} } = req.body || {};
        if (!event) return next(new AppError('EVENT_REQUIRED', 'Body field `event` is required', 422, { validEvents: sm.EVENTS }));

        // Idempotency key: header takes precedence, then body.
        const idempotencyKey = req.get('Idempotency-Key') || (req.body && req.body.idempotency_key) || null;

        const result = await engine.dispatch(workflow.id, event, {
            idempotencyKey,
            actor: actorOf(req),
            source: 'api',
            reason,
            payload,
        });
        return sendSuccess(req, res, {
            workflow: workflowView(result.workflow),
            transition: result.transition,
            idempotent: result.idempotent,
        }, result.idempotent ? 200 : 201);
    } catch (err) {
        return next(err);
    }
};

// ── Advance one canonical step forward ───────────────────────────────────────
const advanceWorkflow = async (req, res, next) => {
    try {
        const workflow = await fetchWorkflowOwned(req.params.id, req, next);
        if (!workflow) return undefined;
        const idempotencyKey = req.get('Idempotency-Key') || (req.body && req.body.idempotency_key) || null;
        const result = await engine.advance(workflow.id, {
            idempotencyKey, actor: actorOf(req), reason: (req.body && req.body.reason) || null, payload: (req.body && req.body.payload) || {},
        });
        return sendSuccess(req, res, {
            workflow: workflowView(result.workflow),
            transition: result.transition,
            idempotent: result.idempotent,
        }, result.idempotent ? 200 : 201);
    } catch (err) {
        return next(err);
    }
};

// ── Webhook subscriptions ────────────────────────────────────────────────────
const createWebhook = async (req, res, next) => {
    try {
        const tenantId = callerTenantId(req) || 'T-DEMO';
        const { url, secret, description = null, event_filters = [], metadata = {} } = req.body || {};
        if (!url) return next(new AppError('URL_REQUIRED', 'Body field `url` is required', 422));
        if (!secret || String(secret).length < 16) {
            return next(new AppError('WEAK_SECRET', 'Body field `secret` is required (min 16 chars)', 422));
        }
        if (!Array.isArray(event_filters)) return next(new AppError('INVALID_FILTERS', '`event_filters` must be an array', 422));
        const hook = await db.WorkflowWebhook.create({
            tenant_id: tenantId, url, secret, description, event_filters, metadata, created_by: actorOf(req),
        });
        // default scope excludes the secret on the returned instance.
        const safe = await db.WorkflowWebhook.findByPk(hook.id);
        return sendSuccess(req, res, safe, 201);
    } catch (err) {
        return next(err);
    }
};

const listWebhooks = async (req, res, next) => {
    try {
        const where = {};
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const rows = await db.WorkflowWebhook.findAll({ where, order: [['created_at', 'DESC']] });
        return sendSuccess(req, res, rows);
    } catch (err) {
        return next(err);
    }
};

const deleteWebhook = async (req, res, next) => {
    try {
        const hook = await db.WorkflowWebhook.findByPk(req.params.id);
        if (!hook) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId && hook.tenant_id !== tenantId) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
        }
        hook.active = false;
        hook.deleted_by = actorOf(req);
        await hook.save();
        await hook.destroy(); // soft delete (paranoid)
        return sendSuccess(req, res, { id: hook.id, deactivated: true });
    } catch (err) {
        return next(err);
    }
};

// ── Webhook delivery log for a workflow ──────────────────────────────────────
const listDeliveries = async (req, res, next) => {
    try {
        const workflow = await fetchWorkflowOwned(req.params.id, req, next);
        if (!workflow) return undefined;
        const rows = await db.WorkflowWebhookDelivery.findAll({
            where: { workflow_id: workflow.id }, order: [['created_at', 'DESC']],
        });
        return sendSuccess(req, res, rows);
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    getDefinition,
    createWorkflow,
    listWorkflows,
    getWorkflow,
    listTransitions,
    dispatchEvent,
    advanceWorkflow,
    createWebhook,
    listWebhooks,
    deleteWebhook,
    listDeliveries,
};
