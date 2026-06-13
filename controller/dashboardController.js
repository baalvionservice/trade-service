'use strict';
/**
 * Trade Operations Dashboard — HTTP surface (War Room 4, Prompt 3).
 *
 * The shared operations dashboard for buyer / seller / admin / logistics / bank.
 * Thin controller: resolve RBAC + party scope, delegate to dashboardService,
 * shape the response. Tenant isolation is enforced by the model hooks + DB RLS;
 * party-level visibility is enforced here via the rbac scope.
 *
 * Endpoints (mounted at /v1/dashboard):
 *   GET  /shipments                 filtered + paginated shipment list
 *   GET  /shipments/:id             shipment detail (+ operation)
 *   GET  /shipments/:id/timeline    merged event / status / workflow timeline
 *   GET  /shipments/:id/readiness   computed readiness score
 *   GET  /shipments/:id/documents   shipment documents (visibility-filtered)
 *   POST /shipments/:id/comments    append a comment to the timeline
 */
const dashboardService = require('../service/dashboard/dashboardService');
const rbac = require('../service/dashboard/rbac');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}
function actorOf(req) {
    return (req.auth && (req.auth.userId || req.auth.email)) || 'system';
}
function isBypass(req) {
    return ((req.auth && req.auth.roles) || []).some((r) => rbac.ADMIN_ROLES.includes(r));
}

/**
 * The org identities the caller can act as a buyer/seller party for. The buyer/
 * seller party id is a trade-domain org code (e.g. COMP-101) which may differ
 * from the gateway tenant/org id. We resolve it from the verified gateway
 * identity ONLY (never a client-supplied header — that would be spoofable):
 * orgCode (preferred), then orgId. Admin / logistics / bank do not need it
 * (scope 'all').
 */
function partyOrgIds(req) {
    const a = req.auth || {};
    const ids = [a.orgCode, a.orgId].filter(Boolean);
    // De-dupe while preserving order.
    return [...new Set(ids)];
}

// Resolve RBAC for the request or short-circuit with 403.
function access(req, next) {
    const resolved = rbac.resolve((req.auth && req.auth.roles) || []);
    if (!resolved.allowed) {
        next(new AppError('FORBIDDEN', 'Not authorized for the trade operations dashboard', 403, { reason: resolved.reason }));
        return null;
    }
    return resolved;
}

// ── GET /shipments — filtered + paginated list ───────────────────────────────
const listShipments = async (req, res, next) => {
    try {
        const acc = access(req, next);
        if (!acc) return undefined;

        const { buyer = null, seller = null, status = null, date_from = null, date_to = null, page, limit } = req.query;
        const result = await dashboardService.listShipments({
            tenantId: callerTenantId(req),
            bypass: isBypass(req),
            access: acc,
            partyOrgIds: partyOrgIds(req),
            buyer,
            seller,
            status: status ? String(status).split(',') : null,
            dateFrom: date_from,
            dateTo: date_to,
            page,
            limit,
        });
        return sendPaginated(req, res, result);
    } catch (err) {
        return next(err);
    }
};

// ── GET /shipments/:id — detail ──────────────────────────────────────────────
const getShipment = async (req, res, next) => {
    try {
        const acc = access(req, next);
        if (!acc) return undefined;
        const shipment = await dashboardService.getShipmentScoped(req.params.id, { access: acc, partyOrgIds: partyOrgIds(req) });
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        return sendSuccess(req, res, shipment.toJSON());
    } catch (err) {
        return next(err);
    }
};

// ── GET /shipments/:id/timeline ──────────────────────────────────────────────
const getTimeline = async (req, res, next) => {
    try {
        const acc = access(req, next);
        if (!acc) return undefined;
        const shipment = await dashboardService.getShipmentScoped(req.params.id, { access: acc, partyOrgIds: partyOrgIds(req) });
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        const timeline = await dashboardService.getTimeline(shipment.id);
        return sendSuccess(req, res, timeline);
    } catch (err) {
        return next(err);
    }
};

// ── GET /shipments/:id/readiness ─────────────────────────────────────────────
const getReadiness = async (req, res, next) => {
    try {
        const acc = access(req, next);
        if (!acc) return undefined;
        const shipment = await dashboardService.getShipmentScoped(req.params.id, { access: acc, partyOrgIds: partyOrgIds(req) });
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        const score = await dashboardService.computeReadiness(shipment);
        return sendSuccess(req, res, { shipment_id: shipment.id, ...score });
    } catch (err) {
        return next(err);
    }
};

// ── GET /shipments/:id/documents ─────────────────────────────────────────────
const getDocuments = async (req, res, next) => {
    try {
        const acc = access(req, next);
        if (!acc) return undefined;
        const shipment = await dashboardService.getShipmentScoped(req.params.id, { access: acc, partyOrgIds: partyOrgIds(req) });
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        const documents = await dashboardService.getDocuments(shipment.id, acc, rbac.canSeeDocument);
        return sendSuccess(req, res, { shipment_id: shipment.id, count: documents.length, documents });
    } catch (err) {
        return next(err);
    }
};

// ── POST /shipments/:id/comments — append a comment to the timeline ──────────
const addComment = async (req, res, next) => {
    try {
        const acc = access(req, next);
        if (!acc) return undefined;
        if (!acc.canComment) return next(new AppError('FORBIDDEN', 'Your role may not comment on shipments', 403));

        const message = (req.body && (req.body.message || req.body.comment || req.body.text) || '').toString().trim();
        if (!message) return next(new AppError('MESSAGE_REQUIRED', 'A non-empty `message` is required', 422));
        if (message.length > 4000) return next(new AppError('MESSAGE_TOO_LONG', 'Comment exceeds 4000 characters', 422));

        const shipment = await dashboardService.getShipmentScoped(req.params.id, { access: acc, partyOrgIds: partyOrgIds(req) });
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));

        const event = await dashboardService.addComment(shipment, {
            message,
            actor: actorOf(req),
            visibility: (req.body && req.body.visibility) || 'all',
            replyTo: (req.body && req.body.reply_to) || null,
        });
        return sendSuccess(req, res, {
            id: event.id,
            shipment_id: shipment.id,
            kind: 'comment',
            message,
            author: actorOf(req),
            at: event.occurred_at,
        }, 201);
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    listShipments,
    getShipment,
    getTimeline,
    getReadiness,
    getDocuments,
    addComment,
};
