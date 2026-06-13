'use strict';
// Logistics Optimization Agent — HTTP surface (War Room 4, Prompt 14).
// Thin controller: tenant ownership (defence in depth over RLS) + delegation to the
// logistics engine orchestrator. A caller can only ever see / drive an optimization
// inside their own tenant (cross-tenant resolves to 404, never 403). Mounted at
// /v1/route_optimizations.
const logistics = require('../service/logistics');
const engine = require('../service/logistics/logisticsEngine');
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
/** Tenant scope applied to engine reads/writes — null for admins (all tenants). */
function scopeTenant(req) {
    return isAdmin(req) ? null : callerTenantId(req);
}

// ── GET /v1/route_optimizations/network ──────────────────────────────────────
// Public descriptor: the lane network, carriers, modes, strategies + provider health.
const getNetwork = (req, res) => {
    const { schema, network, carrierRates, apiIntegration } = logistics;
    const hubs = Object.entries(network.HUBS).map(([code, h]) => ({
        code, name: h.name, country: h.country, modes: h.modes, gateway: !!h.gateway,
    }));
    const carriers = carrierRates.ALL_CARRIERS.map((id) => {
        const c = carrierRates.CARRIERS[id];
        return { id, name: c.name, modes: c.modes, reliability: c.reliability };
    });
    return sendSuccess(req, res, {
        engine_version: schema.ENGINE_VERSION,
        modes: schema.VALID_MODES,
        strategies: schema.VALID_STRATEGIES,
        default_weights: schema.DEFAULT_SCORE_WEIGHTS,
        hubs,
        carriers,
        lane_count: network.BUILTIN_LANES.length,
        providers: apiIntegration.registry(),
        defaults: {
            max_transfers: schema.DEFAULT_MAX_TRANSFERS,
            max_routes: schema.DEFAULT_MAX_ROUTES,
        },
    });
};

// ── POST /v1/route_optimizations/preview ─────────────────────────────────────
// Run the optimizer WITHOUT persisting — stateless cost-vs-speed analysis.
const preview = async (req, res, next) => {
    try {
        const body = req.body || {};
        const request = body.request || body;
        if (!request || typeof request !== 'object') {
            throw new AppError('VALIDATION', '`request` (shipment) object is required', 422);
        }
        const result = logistics.optimizer.optimize(request, {
            strategy: body.strategy, weights: body.weights,
            maxTransfers: body.max_transfers, maxRoutes: body.max_routes,
        });
        return sendSuccess(req, res, result);
    } catch (err) {
        return mapError(err, next);
    }
};

// ── POST /v1/route_optimizations ─────────────────────────────────────────────
// Run the optimizer + persist the run.
const createOptimization = async (req, res, next) => {
    try {
        const body = req.body || {};
        const request = body.request || null;
        if (!request || typeof request !== 'object') {
            throw new AppError('VALIDATION', '`request` (shipment) object is required', 422);
        }
        const { view } = await engine.optimize({
            request,
            strategy: body.strategy,
            weights: body.weights,
            maxTransfers: body.max_transfers,
            maxRoutes: body.max_routes,
            orderId: body.order_id || null,
            shipmentId: body.shipment_id || null,
            tradeOperationId: body.trade_operation_id || null,
            tenantId: callerTenantId(req),
            actor: actorOf(req),
        });
        return sendSuccess(req, res, view, 201);
    } catch (err) {
        return mapError(err, next);
    }
};

// ── GET /v1/route_optimizations ──────────────────────────────────────────────
const listOptimizations = async (req, res, next) => {
    try {
        const { status, shipment_id, order_id, page = 1, limit = 20 } = req.query;
        const result = await engine.listOptimizations({
            tenantId: scopeTenant(req), status, shipmentId: shipment_id, orderId: order_id, page, limit,
        });
        return sendPaginated(req, res, {
            items: result.items.map(engine.toView), total: result.total,
            page: result.page, limit: result.limit, pages: result.pages,
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/route_optimizations/:id ──────────────────────────────────────────
const getOptimization = async (req, res, next) => {
    try {
        const row = await engine.getOptimization(req.params.id, { tenantId: scopeTenant(req) });
        return sendSuccess(req, res, engine.toView(row));
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/route_optimizations/:id/events ───────────────────────────────────
const getEvents = async (req, res, next) => {
    try {
        await engine.getOptimization(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate first
        const events = await engine.listEvents(req.params.id, { tenantId: scopeTenant(req) });
        return sendSuccess(req, res, events);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/route_optimizations/:id/select ──────────────────────────────────
// Commit to a strategy (cheapest/fastest/balanced) or a specific candidate route.
const selectRoute = async (req, res, next) => {
    try {
        const body = req.body || {};
        if (!body.strategy && !body.route_id) {
            throw new AppError('VALIDATION', 'either `strategy` or `route_id` is required', 422);
        }
        await engine.getOptimization(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate
        const view = await engine.selectRoute(req.params.id, {
            strategy: body.strategy || null,
            routeId: body.route_id || null,
            tenantId: scopeTenant(req),
            actor: actorOf(req),
        });
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

/** Map a PURE RouteError into the platform AppError taxonomy. */
function mapError(err, next) {
    if (err && err.name === 'RouteError') {
        const status = err.kind === 'validation' ? 422 : err.kind === 'no_route' ? 422 : 503;
        const ae = new AppError(String(err.kind || 'OPTIMIZATION').toUpperCase(), err.message, status, {
            messages: err.messages || [], detail: err.detail || {},
        });
        return next(ae);
    }
    return next(err);
}

module.exports = {
    getNetwork,
    preview,
    createOptimization,
    listOptimizations,
    getOptimization,
    getEvents,
    selectRoute,
};
