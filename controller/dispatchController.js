'use strict';
// Dispatch Orchestration Engine — HTTP surface (War Room 4, Prompt 11).
// Thin controller: tenant ownership (defence in depth over RLS) + delegation to
// the dispatch orchestrator. A caller can only ever see / drive a plan inside
// their own tenant (cross-tenant resolves to 404, never 403).
const dispatch = require('../service/dispatch');
const engine = dispatch.engine;
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

function isAdmin(req) {
    const role = req.auth && req.auth.role;
    const roles = (req.auth && req.auth.roles) || (role ? [role] : []);
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}
function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}
function actorOf(req) {
    return (req.auth && (req.auth.userId || req.auth.email)) || 'system';
}
/** Tenant scope applied to reads/writes — null for admins (all tenants). */
function scopeTenant(req) {
    return isAdmin(req) ? null : callerTenantId(req);
}

// ── GET /v1/dispatch_orchestrations/config ───────────────────────────────────
// Public descriptor: the gating conditions, status ladder, rule modes + saga steps.
const getConfig = (req, res) => {
    const { schema } = dispatch;
    return sendSuccess(req, res, {
        engine_version: schema.ENGINE_VERSION,
        conditions: schema.ALL_CONDITIONS,
        default_required: schema.DEFAULT_REQUIRED,
        statuses: schema.ALL_STATUSES,
        terminal_statuses: schema.TERMINAL_STATUSES,
        recoverable_statuses: schema.RECOVERABLE_STATUSES,
        rule_modes: schema.VALID_RULE_MODES,
        steps: schema.DEFAULT_DISPATCH_STEPS,
        workflow_state_condition: schema.WORKFLOW_STATE_CONDITION,
    });
};

// ── POST /v1/dispatch_orchestrations ─────────────────────────────────────────
const createPlan = async (req, res, next) => {
    try {
        const body = req.body || {};
        const { view } = await engine.createPlan({
            workflowId: body.workflow_id || null,
            shipmentId: body.shipment_id || null,
            tradeOperationId: body.trade_operation_id || null,
            reference: body.reference || null,
            rule: body.rule || {},
            autoDispatch: body.auto_dispatch !== false,
            conditions: body.conditions || null,
            metadata: body.metadata || {},
            tenantId: callerTenantId(req),
            actor: actorOf(req),
        });
        return sendSuccess(req, res, view, 201);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/dispatch_orchestrations ──────────────────────────────────────────
const listPlans = async (req, res, next) => {
    try {
        const { status, workflow_id, shipment_id, page = 1, limit = 20 } = req.query;
        const result = await engine.listPlans({
            tenantId: scopeTenant(req), status, workflowId: workflow_id, shipmentId: shipment_id, page, limit,
        });
        return sendPaginated(req, res, {
            items: result.items.map(engine.toView), total: result.total,
            page: result.page, limit: result.limit, pages: result.pages,
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/dispatch_orchestrations/:id ──────────────────────────────────────
const getPlan = async (req, res, next) => {
    try {
        const row = await engine.getPlan(req.params.id, { tenantId: scopeTenant(req) });
        return sendSuccess(req, res, engine.toView(row));
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/dispatch_orchestrations/:id/events ───────────────────────────────
const getEvents = async (req, res, next) => {
    try {
        await engine.getPlan(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate (404 first)
        const events = await engine.listEvents(req.params.id, { tenantId: scopeTenant(req) });
        return sendSuccess(req, res, events);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/dispatch_orchestrations/:id/signals ─────────────────────────────
// Manually signal a gate (documents_validated / compliance_passed / customs_ready /
// freight_booked). Normally driven automatically by workflow transitions.
const signalCondition = async (req, res, next) => {
    try {
        const body = req.body || {};
        if (!body.condition) throw new AppError('VALIDATION', '`condition` is required', 422);
        await engine.getPlan(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate
        const { view, decision, idempotent } = await engine.signalCondition(req.params.id, body.condition, {
            met: body.met !== false,
            source: body.source || 'api',
            detail: body.detail || {},
            actor: actorOf(req),
            idempotencyKey: body.idempotency_key || null,
        });
        return sendSuccess(req, res, { ...view, _decision: decision, _idempotent: idempotent });
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/dispatch_orchestrations/:id/dispatch ────────────────────────────
// Trigger dispatch now. `force: true` (admin) bypasses the rule / manual hold.
const triggerDispatch = async (req, res, next) => {
    try {
        await engine.getPlan(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate
        const force = isAdmin(req) && req.body && req.body.force === true;
        const { view, outcome } = await engine.triggerDispatch(req.params.id, {
            actor: actorOf(req), tenantId: scopeTenant(req), force,
        });
        return sendSuccess(req, res, { ...view, _outcome: outcome || null });
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/dispatch_orchestrations/:id/rollback ────────────────────────────
const rollback = async (req, res, next) => {
    try {
        await engine.getPlan(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate
        const { view, compensated, compensationErrors } = await engine.rollback(req.params.id, {
            actor: actorOf(req), tenantId: scopeTenant(req), reason: (req.body && req.body.reason) || null,
        });
        return sendSuccess(req, res, { ...view, _compensated: compensated, _compensationErrors: compensationErrors });
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/dispatch_orchestrations/:id/retry ───────────────────────────────
const retryDispatch = async (req, res, next) => {
    try {
        await engine.getPlan(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate
        const { view } = await engine.retryDispatch(req.params.id, {
            actor: actorOf(req), tenantId: scopeTenant(req),
            force: isAdmin(req) && req.body && req.body.force === true,
        });
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/dispatch_orchestrations/:id/cancel ──────────────────────────────
const cancelPlan = async (req, res, next) => {
    try {
        await engine.getPlan(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate
        const { view } = await engine.cancel(req.params.id, {
            actor: actorOf(req), tenantId: scopeTenant(req), reason: (req.body && req.body.reason) || null,
        });
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    getConfig,
    createPlan,
    listPlans,
    getPlan,
    getEvents,
    signalCondition,
    triggerDispatch,
    rollback,
    retryDispatch,
    cancelPlan,
};
