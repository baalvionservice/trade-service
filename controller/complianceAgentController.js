'use strict';
// Compliance AI Agent — HTTP surface (War Room 4, Prompt 13).
// Thin controller: tenant ownership (defence in depth over RLS) + delegation to
// the agent. Surfaces:
//   • assessment — ad-hoc (POST /assess) + shipment-scoped (persisted) + history.
//   • a public /definition descriptor of the agent's risk model.
// Distinct from /v1/compliance_screening (Prompt 8 rule engine) — this is the AI
// agent layer that fuses that engine with a probabilistic AI risk layer.
const db = require('../models');
const agentSvc = require('../service/complianceAgent');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const { agent, schema, aiAnalyzer, signals } = agentSvc;

const DECISION_VALUES = new Set(Object.values(schema.AGENT_DECISION));
const RISK_LEVELS = new Set(['minimal', 'low', 'moderate', 'high', 'critical']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cross-tenant bypass roles — kept in lockstep with the compliance/readiness/
// dispatch controllers. A `compliance` role is NOT a cross-tenant bypass: a
// tenant's assessments stay isolated to that tenant.
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

/** Load a shipment and enforce tenant ownership; 404 on cross-tenant. */
async function fetchShipmentOwned(id, req, next) {
    const shipment = await db.TradeShipment.findByPk(id);
    if (!shipment) { next(new AppError('NOT_FOUND', 'Shipment not found', 404)); return null; }
    if (isAdmin(req)) return shipment;
    const tenantId = callerTenantId(req);
    if (tenantId && shipment.tenant_id && shipment.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Shipment not found', 404)); return null;
    }
    return shipment;
}

// ── GET /v1/compliance_agent/definition ───────────────────────────────────────
// Public descriptor: the risk categories, sources, decisions, confidence bands
// and the AI provider currently wired in.
const getDefinition = (req, res) => sendSuccess(req, res, {
    engine_version: agent.ENGINE_VERSION,
    decisions: schema.AGENT_DECISION,
    sources: schema.SOURCE,
    severities: schema.SEVERITY,
    risk_levels: [...RISK_LEVELS],
    risk_categories: schema.ALL_CATEGORIES,
    rule_grounded_categories: [...schema.RULE_GROUNDED],
    confidence_bands: schema.CONFIDENCE_BAND,
    ai_provider: aiAnalyzer.getProvider().name,
    triggers: ['manual', 'api', 'workflow_transition', 'dispatch_gate', 'order', 'placement', 'scheduler', 'backfill'],
    note: 'Hybrid rule + AI agent. The rule layer reuses the Prompt 8 sanctions engine (illustrative dataset — replace with a licensed feed for production); the AI layer is a pluggable, deterministic heuristic by default.',
});

// ── POST /v1/compliance_agent/assess ──────────────────────────────────────────
// Ad-hoc, stateless assessment of an arbitrary shipment/subject (no persistence).
const assessAdhoc = async (req, res, next) => {
    try {
        const body = req.body || {};
        const tenantId = callerTenantId(req);
        const report = await agent.assess(body, { tenantId, runHooks: body.runHooks !== false });
        return sendSuccess(req, res, report);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/compliance_agent/shipments/:shipmentId ────────────────────────────
// The live, cached assessment for a shipment (seeds one on first read).
const getShipmentLatest = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.shipmentId, req, next);
        if (!shipment) return undefined;
        const view = await agent.getLatest(shipment);
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/compliance_agent/shipments/:shipmentId/assess ────────────────────
// Force a fresh assessment + persisted snapshot + cache refresh.
const assessShipment = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.shipmentId, req, next);
        if (!shipment) return undefined;
        const body = req.body || {};
        const { view } = await agent.assessShipment(shipment.id, {
            overrides: body.overrides || {},
            trigger: 'api',
            reason: body.reason || null,
            actor: actorOf(req),
            tenantId: shipment.tenant_id,
            runHooks: body.runHooks !== false,
        });
        return sendSuccess(req, res, view, 201);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/compliance_agent/shipments/:shipmentId/history ────────────────────
const getShipmentHistory = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.shipmentId, req, next);
        if (!shipment) return undefined;
        const { page = 1, limit = 20 } = req.query;
        const result = await agent.listHistory(shipment.id, { page, limit, tenantId: shipment.tenant_id });
        return sendPaginated(req, res, {
            items: result.items, total: result.total, page: result.page, limit: result.limit, pages: result.pages,
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/compliance_agent ──────────────────────────────────────────────────
// List persisted assessments across the tenant (filter by decision / level / ship).
const listAssessments = async (req, res, next) => {
    try {
        const { decision, risk_level, shipment_id, blocking, page = 1, limit = 20 } = req.query;
        const where = {};
        if (typeof decision === 'string' && DECISION_VALUES.has(decision)) where.decision = decision;
        if (typeof risk_level === 'string' && RISK_LEVELS.has(risk_level)) where.risk_level = risk_level;
        if (typeof shipment_id === 'string' && UUID_RE.test(shipment_id)) where.shipment_id = shipment_id;
        if (blocking !== undefined) where.blocking = blocking === 'true' || blocking === true;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const p = Math.max(1, Number(page) || 1);
        const l = Math.min(100, Math.max(1, Number(limit) || 20));
        const { count, rows } = await db.ComplianceAssessment.findAndCountAll({
            where, limit: l, offset: (p - 1) * l, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: p, limit: l });
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    getDefinition,
    assessAdhoc,
    getShipmentLatest,
    assessShipment,
    getShipmentHistory,
    listAssessments,
};
