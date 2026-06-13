'use strict';
// Customs Gateway Abstraction Layer — HTTP surface (War Room 4, Prompt 9).
// Thin controller: tenant ownership (defence in depth over RLS) + delegation to
// the gateway orchestrator. A caller can only ever see / drive a submission inside
// their own tenant (cross-tenant resolves to 404, never 403).
const gateway = require('../service/customs/customsGateway');
const customs = require('../service/customs');
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

// ── GET /v1/customs_submissions/channels ─────────────────────────────────────
// Public descriptor: the connector architecture + country routing + status model.
const getChannels = (req, res) => {
    const { schema } = customs;
    return sendSuccess(req, res, {
        engine_version: schema.ENGINE_VERSION,
        channels: schema.VALID_CHANNELS,
        supported_channels: customs.connectors.supportedChannels(),
        country_routing: schema.COUNTRY_CHANNEL,
        statuses: Object.values(schema.STATUS),
        terminal_statuses: schema.TERMINAL_STATUSES,
        failure_kinds: Object.values(schema.FAILURE_KIND),
        retry: { default_max_attempts: schema.DEFAULT_MAX_ATTEMPTS, backoff_ms: schema.DEFAULT_BACKOFF_MS },
    });
};

// ── POST /v1/customs_submissions ─────────────────────────────────────────────
// Create + dispatch a customs filing through the country-appropriate connector.
const createSubmission = async (req, res, next) => {
    try {
        const body = req.body || {};
        if (!body.declaration || typeof body.declaration !== 'object') {
            throw new AppError('VALIDATION', '`declaration` object is required', 422);
        }
        const { view, deduplicated } = await gateway.submit({
            declaration: body.declaration,
            channel: body.channel || null,
            destinationCountry: body.destination_country || null,
            customsEntryId: body.customs_entry_id || null,
            shipmentId: body.shipment_id || null,
            tradeOperationId: body.trade_operation_id || null,
            idempotencyKey: body.idempotency_key || null,
            maxAttempts: body.max_attempts,
            inline: body.inline === true,
            tenantId: callerTenantId(req),
            actor: actorOf(req),
        });
        return sendSuccess(req, res, view, deduplicated ? 200 : 201);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/customs_submissions ──────────────────────────────────────────────
const listSubmissions = async (req, res, next) => {
    try {
        const { status, channel, shipment_id, page = 1, limit = 20 } = req.query;
        const result = await gateway.listSubmissions({
            tenantId: scopeTenant(req), status, channel, shipmentId: shipment_id, page, limit,
        });
        return sendPaginated(req, res, {
            items: result.items.map(gateway.toView), total: result.total,
            page: result.page, limit: result.limit, pages: result.pages,
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/customs_submissions/:id ──────────────────────────────────────────
const getSubmission = async (req, res, next) => {
    try {
        const row = await gateway.getSubmission(req.params.id, { tenantId: scopeTenant(req) });
        return sendSuccess(req, res, gateway.toView(row));
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/customs_submissions/:id/events ───────────────────────────────────
const getEvents = async (req, res, next) => {
    try {
        // Resolve (ownership-checked) first so cross-tenant ids 404 before any read.
        await gateway.getSubmission(req.params.id, { tenantId: scopeTenant(req) });
        const events = await gateway.listEvents(req.params.id, { tenantId: scopeTenant(req) });
        return sendSuccess(req, res, events);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/customs_submissions/:id/retry ───────────────────────────────────
const retrySubmission = async (req, res, next) => {
    try {
        await gateway.getSubmission(req.params.id, { tenantId: scopeTenant(req) });
        const { view } = await gateway.retrySubmission(req.params.id, {
            actor: actorOf(req), tenantId: scopeTenant(req),
            force: isAdmin(req) && req.body && req.body.force === true,
        });
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/customs_submissions/:id/cancel ──────────────────────────────────
const cancelSubmission = async (req, res, next) => {
    try {
        await gateway.getSubmission(req.params.id, { tenantId: scopeTenant(req) });
        const { view } = await gateway.cancel(req.params.id, {
            actor: actorOf(req), tenantId: scopeTenant(req),
            reason: (req.body && req.body.reason) || null,
        });
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/customs_submissions/recover ─────────────────────────────────────
// Admin-only failure-recovery sweep: re-enqueue in-flight submissions that stalled.
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
    getChannels,
    createSubmission,
    listSubmissions,
    getSubmission,
    getEvents,
    retrySubmission,
    cancelSubmission,
    recoverStalled,
};
