'use strict';
// Freight Marketplace Integration Layer — HTTP surface (War Room 4, Prompt 10).
// Thin controller: tenant ownership (defence in depth over RLS) + delegation to the
// freight gateway orchestrator. A caller can only ever see / drive a booking inside
// their own tenant (cross-tenant resolves to 404, never 403). Mounted at /v1/freight,
// distinct from the legacy /carriers + /shipping_quotes store-shadow endpoints.
const freight = require('../service/freight');
const gateway = require('../service/freight/freightGateway');
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
/** Tenant scope applied to gateway reads/writes — null for admins (all tenants). */
function scopeTenant(req) {
    return isAdmin(req) ? null : callerTenantId(req);
}

// ── GET /v1/freight/carriers ─────────────────────────────────────────────────
// Public descriptor: the carrier marketplace, capabilities, modes + status model.
const getCarriers = (req, res) => {
    const { schema } = freight;
    const carriers = schema.VALID_CARRIERS.map((c) => {
        const p = schema.CARRIER_PROFILES[c];
        return { carrier: c, name: p.name, modes: p.modes, reliability: p.reliability, default_currency: p.default_currency };
    });
    return sendSuccess(req, res, {
        engine_version: schema.ENGINE_VERSION,
        carriers,
        supported_carriers: freight.connectors.supportedCarriers(),
        modes: schema.VALID_MODES,
        ranking: schema.VALID_RANKS,
        statuses: Object.values(schema.STATUS),
        terminal_statuses: schema.TERMINAL_STATUSES,
        failure_kinds: Object.values(schema.FAILURE_KIND),
        defaults: {
            max_attempts: schema.DEFAULT_MAX_ATTEMPTS,
            backoff_ms: schema.DEFAULT_BACKOFF_MS,
            quote_ttl_hours: schema.DEFAULT_QUOTE_TTL_HOURS,
            max_fallbacks: schema.DEFAULT_MAX_FALLBACKS,
        },
    });
};

// ── POST /v1/freight/quotes ──────────────────────────────────────────────────
// Run the comparison engine: fan out across eligible carriers + rank. No commitment.
const compareQuotes = async (req, res, next) => {
    try {
        const body = req.body || {};
        const request = body.request || body;
        if (!request || typeof request !== 'object') {
            throw new AppError('VALIDATION', '`request` (shipment) object is required', 422);
        }
        const comparison = await gateway.quote({
            request, rank: body.rank, weights: body.weights, ttlHours: body.ttl_hours,
        });
        // Strip the bulky raw carrier payloads from the API view (kept server-side).
        const slim = (q) => q && { ...q, raw: undefined };
        return sendSuccess(req, res, {
            request: comparison.request,
            rank: comparison.rank,
            quotes: comparison.ranked.map(slim),
            cheapest: slim(comparison.cheapest),
            fastest: slim(comparison.fastest),
            best: slim(comparison.best),
            errors: comparison.errors,
            carriers_quoted: comparison.carriers_quoted,
            carriers_failed: comparison.carriers_failed,
            valid_until: comparison.valid_until,
        });
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/freight ─────────────────────────────────────────────────────────
// Create + drive a booking through the carrier-fallback workflow.
const createBooking = async (req, res, next) => {
    try {
        const body = req.body || {};
        const request = body.request || null;
        if (!request || typeof request !== 'object') {
            throw new AppError('VALIDATION', '`request` (shipment) object is required', 422);
        }
        const { view, deduplicated } = await gateway.book({
            request,
            preferredCarrier: body.preferred_carrier || body.carrier || null,
            maxFallbacks: body.max_fallbacks,
            orderId: body.order_id || null,
            shipmentId: body.shipment_id || null,
            tradeOperationId: body.trade_operation_id || null,
            idempotencyKey: body.idempotency_key || null,
            tenantId: callerTenantId(req),
            actor: actorOf(req),
        });
        return sendSuccess(req, res, view, deduplicated ? 200 : 201);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/freight ──────────────────────────────────────────────────────────
const listBookings = async (req, res, next) => {
    try {
        const { status, carrier, shipment_id, order_id, page = 1, limit = 20 } = req.query;
        const result = await gateway.listBookings({
            tenantId: scopeTenant(req), status, carrier, shipmentId: shipment_id, orderId: order_id, page, limit,
        });
        return sendPaginated(req, res, {
            items: result.items.map(gateway.toView), total: result.total,
            page: result.page, limit: result.limit, pages: result.pages,
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/freight/:id ──────────────────────────────────────────────────────
const getBooking = async (req, res, next) => {
    try {
        const row = await gateway.getBooking(req.params.id, { tenantId: scopeTenant(req) });
        return sendSuccess(req, res, gateway.toView(row));
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/freight/:id/events ───────────────────────────────────────────────
const getEvents = async (req, res, next) => {
    try {
        await gateway.getBooking(req.params.id, { tenantId: scopeTenant(req) }); // ownership gate first
        const events = await gateway.listEvents(req.params.id, { tenantId: scopeTenant(req) });
        return sendSuccess(req, res, events);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/freight/:id/status ──────────────────────────────────────────────
// Advance the booking lifecycle (carrier tracking webhook / manual update).
const updateStatus = async (req, res, next) => {
    try {
        const next_status = req.body && (req.body.status || req.body.next_status);
        if (!next_status) throw new AppError('VALIDATION', '`status` is required', 422);
        await gateway.getBooking(req.params.id, { tenantId: scopeTenant(req) });
        const { view } = await gateway.updateStatus(req.params.id, next_status, {
            actor: actorOf(req), tenantId: scopeTenant(req), detail: (req.body && req.body.detail) || {},
        });
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/freight/:id/retry ───────────────────────────────────────────────
const retryBooking = async (req, res, next) => {
    try {
        await gateway.getBooking(req.params.id, { tenantId: scopeTenant(req) });
        const { view } = await gateway.retryBooking(req.params.id, {
            actor: actorOf(req), tenantId: scopeTenant(req),
        });
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/freight/:id/cancel ──────────────────────────────────────────────
const cancelBooking = async (req, res, next) => {
    try {
        await gateway.getBooking(req.params.id, { tenantId: scopeTenant(req) });
        const { view } = await gateway.cancel(req.params.id, {
            actor: actorOf(req), tenantId: scopeTenant(req), reason: (req.body && req.body.reason) || null,
        });
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/freight/recover ─────────────────────────────────────────────────
// Admin-only recovery sweep: re-drive bookings stalled in `booking`.
const recoverStalled = async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw new AppError('FORBIDDEN', 'Admin role required for recovery sweep', 403);
        const olderThanMs = Number(req.body && req.body.older_than_ms) || undefined;
        const result = await gateway.recoverStalled({ olderThanMs });
        return sendSuccess(req, res, result);
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    getCarriers,
    compareQuotes,
    createBooking,
    listBookings,
    getBooking,
    getEvents,
    updateStatus,
    retryBooking,
    cancelBooking,
    recoverStalled,
};
