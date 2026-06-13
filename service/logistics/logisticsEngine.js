'use strict';
/**
 * Logistics Engine — DB-backed ORCHESTRATOR (War Room 4, Prompt 14).
 *
 * Wraps the PURE optimizer with the persistence + lifecycle the optimizer deliberately
 * avoids:
 *
 *   • optimize()      — runs the optimizer and PERSISTS a tradeops.route_optimizations
 *                       row capturing the request, the ranked candidate routes, the
 *                       cheapest / fastest / balanced picks, and any warnings. Every
 *                       run appends an immutable row to route_optimization_events.
 *
 *   • selectRoute()   — records the caller committing to a strategy (cheapest / fastest
 *                       / balanced) or a specific candidate route; flips status to
 *                       `selected` and appends the decision to the audit. This is the
 *                       hand-off point to the Freight Marketplace (Prompt 10), which
 *                       books the chosen route's first leg.
 *
 *   • read paths      — getOptimization / listOptimizations / listEvents, all tenant
 *                       scoped (RLS + the index.js hooks; defence-in-depth in the
 *                       controller).
 *
 * The optimizer is fully deterministic + offline by default; the persistence here is
 * the only stateful part. A missing migration degrades gracefully (events best-effort).
 */

const db = require('../../models');
const optimizer = require('./optimizer');
const net = require('./network');
const { ENGINE_VERSION, STRATEGY, VALID_STRATEGIES } = require('./schema');

const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

/** Strip the bulky per-leg `raw`/internal noise for a compact persisted snapshot. */
function slimRoute(route) {
    if (!route) return null;
    return {
        id: route.id,
        hops: route.hops,
        path: route.path,
        modes: route.modes,
        carriers: route.carriers,
        total_cost: route.total_cost,
        total_transit_days: route.total_transit_days,
        total_distance_km: route.total_distance_km,
        reliability: route.reliability,
        co2_kg: route.co2_kg,
        currency: route.currency,
        transfers: route.transfers,
        estimated: route.estimated,
        score: route.score,
        score_breakdown: route.score_breakdown,
        legs: route.legs,
    };
}

/** Append an immutable lifecycle event (best-effort — never breaks the caller). */
async function appendEvent(row, { eventType, strategy = null, message = null, detail = {}, actor = null }) {
    if (!db.RouteOptimizationEvent) return null;
    try {
        return await db.RouteOptimizationEvent.create({
            tenant_id: row.tenant_id,
            optimization_id: row.id,
            event_type: eventType,
            strategy,
            message: message ? String(message).slice(0, 1000) : null,
            detail: detail || {},
            created_by: actor || 'system',
        });
    } catch {
        return null;
    }
}

/** Normalize a persisted row into the stable API view. */
function toView(row) {
    const r = plain(row);
    return {
        id: r.id,
        status: r.status,
        reference: r.reference,
        order_id: r.order_id,
        shipment_id: r.shipment_id,
        trade_operation_id: r.trade_operation_id,
        origin: r.origin,
        destination: r.destination,
        origin_hub: r.origin_hub,
        destination_hub: r.destination_hub,
        weight_kg: r.weight_kg != null ? Number(r.weight_kg) : null,
        strategy: r.strategy,
        routes: r.routes || [],
        cheapest: r.cheapest || null,
        fastest: r.fastest || null,
        balanced: r.balanced || null,
        recommended: r.recommended || null,
        selected_strategy: r.selected_strategy || null,
        selected_route: r.selected_route || null,
        warnings: r.warnings || [],
        weights: r.weights || null,
        engine_version: r.engine_version,
        created_by: r.created_by,
        created_at: r.created_at || null,
        updated_at: r.updated_at || null,
    };
}

/**
 * Run the optimizer and persist the result.
 *
 * @param {object} input
 * @param {object} input.request   the optimization request
 * @param {string} [input.strategy]
 * @param {object} [input.weights]
 * @param {number} [input.maxTransfers]
 * @param {number} [input.maxRoutes]
 * @param {string} [input.orderId] [input.shipmentId] [input.tradeOperationId]
 * @param {string} [input.tenantId] [input.actor]
 * @param {boolean} [input.persist=true]
 * @returns {Promise<{ result, view, record }>}
 */
async function optimize(input = {}) {
    const result = optimizer.optimize(input.request || input, {
        strategy: input.strategy,
        weights: input.weights,
        maxTransfers: input.maxTransfers,
        maxRoutes: input.maxRoutes,
        generatedAt: input.generatedAt || null,
    });

    const request = result.request;
    const oHub = net.resolveHub(request.origin).hub;
    const dHub = net.resolveHub(request.destination).hub;

    if (input.persist === false || !db.RouteOptimization) {
        return { result, view: null, record: null };
    }

    const tenantId = input.tenantId || null;
    const record = await db.RouteOptimization.create({
        ...(tenantId ? { tenant_id: tenantId } : {}),
        reference: request.reference,
        order_id: input.orderId || null,
        shipment_id: input.shipmentId || null,
        trade_operation_id: input.tradeOperationId || null,
        origin: request.origin || {},
        destination: request.destination || {},
        origin_hub: oHub,
        destination_hub: dHub,
        weight_kg: request.weight_kg || null,
        request,
        strategy: result.strategy,
        status: 'optimized',
        routes: (result.routes || []).map(slimRoute),
        cheapest: slimRoute(result.cheapest),
        fastest: slimRoute(result.fastest),
        balanced: slimRoute(result.balanced),
        recommended: slimRoute(result.recommended),
        warnings: result.warnings || [],
        weights: result.weights || null,
        engine_version: ENGINE_VERSION,
        created_by: input.actor || null,
    });

    await appendEvent(record, {
        eventType: 'optimized',
        strategy: result.strategy,
        message: `${(result.routes || []).length} candidate route(s); cheapest=${result.cheapest ? result.cheapest.total_cost : 'n/a'} fastest=${result.fastest ? result.fastest.total_transit_days + 'd' : 'n/a'}`,
        detail: { warnings: result.warnings || [], origin_hub: oHub, destination_hub: dHub },
        actor: input.actor,
    });

    return { result, view: toView(record), record };
}

const { AppError } = require('../../utils/errors');

/** Load a persisted optimization, tenant-scoped. 404 (never 403) cross-tenant. */
async function getOptimization(id, { tenantId = null } = {}) {
    const where = { id };
    if (tenantId) where.tenant_id = tenantId;
    const row = await db.RouteOptimization.findOne({ where });
    if (!row) throw new AppError('NOT_FOUND', 'route optimization not found', 404);
    return row;
}

/** List optimizations, tenant-scoped + filterable + paginated. */
async function listOptimizations({ tenantId = null, status, shipmentId, orderId, page = 1, limit = 20 } = {}) {
    const where = {};
    if (tenantId) where.tenant_id = tenantId;
    if (status) where.status = status;
    if (shipmentId) where.shipment_id = shipmentId;
    if (orderId) where.order_id = orderId;
    const lim = Math.min(100, Math.max(1, Number(limit) || 20));
    const pg = Math.max(1, Number(page) || 1);
    const { rows, count } = await db.RouteOptimization.findAndCountAll({
        where, order: [['created_at', 'DESC']], limit: lim, offset: (pg - 1) * lim,
    });
    return { items: rows, total: count, page: pg, limit: lim, pages: Math.ceil(count / lim) || 1 };
}

/**
 * Record the caller selecting a strategy or a specific candidate route. Flips status
 * to `selected` and appends the decision. Returns the updated view.
 */
async function selectRoute(id, { strategy = null, routeId = null, tenantId = null, actor = 'system' } = {}) {
    const row = await getOptimization(id, { tenantId });
    const r = plain(row);

    let selectedRoute = null;
    let selectedStrategy = null;

    if (routeId) {
        selectedRoute = (r.routes || []).find((rt) => rt.id === routeId)
            || [r.cheapest, r.fastest, r.balanced, r.recommended].find((rt) => rt && rt.id === routeId)
            || null;
        if (!selectedRoute) throw new AppError('VALIDATION', `route '${routeId}' is not part of this optimization`, 422);
        selectedStrategy = 'explicit';
    } else {
        const strat = VALID_STRATEGIES.includes(strategy) ? strategy : STRATEGY.BALANCED;
        selectedStrategy = strat;
        selectedRoute = strat === STRATEGY.CHEAPEST ? r.cheapest
            : strat === STRATEGY.FASTEST ? r.fastest
                : r.balanced || r.recommended;
        if (!selectedRoute) throw new AppError('VALIDATION', `no ${strat} route available to select`, 422);
    }

    await row.update({ status: 'selected', selected_strategy: selectedStrategy, selected_route: selectedRoute });
    await appendEvent(row, {
        eventType: 'selected',
        strategy: selectedStrategy,
        message: `selected ${selectedStrategy} route ${selectedRoute.id} (${selectedRoute.total_cost} ${selectedRoute.currency}, ${selectedRoute.total_transit_days}d)`,
        detail: { route_id: selectedRoute.id },
        actor,
    });

    return toView(row);
}

/** List the append-only audit for an optimization, tenant-scoped. */
async function listEvents(id, { tenantId = null } = {}) {
    if (!db.RouteOptimizationEvent) return [];
    const where = { optimization_id: id };
    if (tenantId) where.tenant_id = tenantId;
    const rows = await db.RouteOptimizationEvent.findAll({ where, order: [['created_at', 'ASC']] });
    return rows.map(plain);
}

module.exports = {
    optimize,
    getOptimization,
    listOptimizations,
    selectRoute,
    listEvents,
    toView,
    slimRoute,
};
