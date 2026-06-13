'use strict';
// Shipment Readiness Score Engine — HTTP surface (War Room 4, Prompt 6).
// Thin controller: tenant ownership (defence in depth over RLS) + delegation to
// the engine. The shipment is resolved + ownership-checked before any score read,
// so a caller can only ever score a shipment inside their own tenant.
const db = require('../models');
const engine = require('../service/readiness/readinessEngine');
const scoring = require('../service/readiness/scoring');
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

/** Load a shipment and enforce tenant ownership; 404 (not 403) on cross-tenant. */
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

// ── GET /v1/shipment_readiness/definition ────────────────────────────────────
// Public descriptor: the weighted model + component meanings (for clients / UI).
const getDefinition = (req, res) => sendSuccess(req, res, {
    engine_version: scoring.ENGINE_VERSION,
    weights: scoring.WEIGHTS,
    bands: { high: '>= 80', medium: '50–79', low: '< 50' },
    required_documents: scoring.REQUIRED_DOC_TYPES,
    components: {
        documentation: 'Verified trade documents vs. the required set.',
        compliance: 'Progress along the linear workflow lifecycle.',
        logistics: 'Completeness of carrier / tracking / routing data.',
        risk: 'Safety score (100 = no risk): failed validations, workflow failure, troubled/cancelled shipment, overdue ETA, sanctions hold, uninsured high value.',
    },
    risk_signals: scoring.RISK_WEIGHTS,
    high_value_threshold: scoring.HIGH_VALUE_THRESHOLD,
    triggers: ['manual', 'api', 'workflow_transition', 'document_validation', 'shipment_status', 'scheduler', 'backfill'],
});

// ── GET /v1/shipment_readiness/:shipmentId ───────────────────────────────────
// The live, cached readiness score for a shipment (seeds a snapshot on first read).
const getReadiness = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.shipmentId, req, next);
        if (!shipment) return undefined;
        const view = await engine.getLatest(shipment);
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/shipment_readiness/:shipmentId/recalculate ──────────────────────
// Force a fresh recomputation + persisted snapshot + cache refresh.
const recalculate = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.shipmentId, req, next);
        if (!shipment) return undefined;
        const reason = (req.body && req.body.reason) || null;
        const { view } = await engine.recalculate(shipment.id, {
            trigger: 'api', reason, actor: actorOf(req), tenantId: shipment.tenant_id,
        });
        return sendSuccess(req, res, view, 201);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/shipment_readiness/:shipmentId/history ───────────────────────────
// Paginated snapshot time series (newest first) — the readiness trend.
const getHistory = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.shipmentId, req, next);
        if (!shipment) return undefined;
        const { page = 1, limit = 20 } = req.query;
        const result = await engine.listHistory(shipment.id, { page, limit, tenantId: shipment.tenant_id });
        return sendPaginated(req, res, {
            items: result.items, total: result.total, page: result.page, limit: result.limit, pages: result.pages,
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/shipment_readiness ───────────────────────────────────────────────
// List persisted snapshots across the tenant (filterable by band / shipment / op).
const listScores = async (req, res, next) => {
    try {
        const {
            shipment_id, trade_operation_id, band, trigger, page = 1, limit = 20,
        } = req.query;
        const where = {};
        if (shipment_id) where.shipment_id = shipment_id;
        if (trade_operation_id) where.trade_operation_id = trade_operation_id;
        if (band) where.band = band;
        if (trigger) where.trigger = trigger;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const p = Math.max(1, Number(page) || 1);
        const l = Math.min(100, Math.max(1, Number(limit) || 20));
        const { count, rows } = await db.ShipmentReadiness.findAndCountAll({
            where, limit: l, offset: (p - 1) * l, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: p, limit: l });
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    getDefinition,
    getReadiness,
    recalculate,
    getHistory,
    listScores,
};
