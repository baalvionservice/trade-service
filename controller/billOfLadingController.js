'use strict';
/**
 * Digital Bill of Lading (Logistics #3) — a document of title with a negotiable-instrument lifecycle:
 *   draft → issued → (transferred…) → surrendered → released   (or → cancelled)
 * Title moves with `current_holder`; every endorsement is appended to `holder_history`. Carrier/shipper
 * e-signatures go through the e-sign provider seam. Real, typed, persisted — not the document vault.
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const providers = require('../providers');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

// Allowed status transitions.
const VALID = {
    draft: ['issued', 'cancelled'],
    issued: ['transferred', 'surrendered', 'cancelled'],
    transferred: ['transferred', 'surrendered'],
    surrendered: ['released'],
    released: [],
    cancelled: [],
};

function assertTransition(bl, to) {
    const allowed = VALID[bl.status] || [];
    if (!allowed.includes(to)) {
        throw new AppError('INVALID_TRANSITION', `cannot ${to} a bill of lading in '${bl.status}' state`, 409);
    }
}

const genId = () => `BL-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const genBlNumber = (carrierId) => {
    const prefix = (carrierId || 'BAAL').replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'BAAL';
    return `${prefix}${crypto.randomInt(1000000, 9999999)}`;
};

const holderName = (party) => (party && (party.name || party.org || party.orgId)) || null;

// ── Tenant helpers ────────────────────────────────────────────────────────────
function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || [];
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}

function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}

// Fetch a BillOfLading by PK and enforce tenant ownership.
// Returns the record or calls next(err) and returns null.
async function fetchBlOwned(id, req, next) {
    const bl = await db.BillOfLading.findByPk(id);
    if (!bl) { next(new AppError('NOT_FOUND', 'Bill of lading not found', 404)); return null; }
    if (isAdmin(req)) return bl;
    const tenantId = callerTenantId(req);
    if (tenantId && bl.tenant_id && bl.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Bill of lading not found', 404)); return null;
    }
    return bl;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
const list = async (req, res, next) => {
    try {
        const { shipment_id, order_id, status, holder, page = 1, limit = 20 } = req.query;
        const where = {};
        if (shipment_id) where.shipment_id = shipment_id;
        if (order_id) where.order_id = order_id;
        if (status) where.status = status;
        if (holder) where.current_holder = holder;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.BillOfLading.findAndCountAll({ where, limit: Number(limit), offset, order: [['created_at', 'DESC']] });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) { return next(err); }
};

const get = async (req, res, next) => {
    try {
        const bl = await fetchBlOwned(req.params.id, req, next);
        if (!bl) return undefined;
        return sendSuccess(req, res, bl);
    } catch (err) { return next(err); }
};

const create = async (req, res, next) => {
    try {
        const body = req.body || {};
        // Strip any client-supplied tenant_id; stamp from server context instead.
        const { tenant_id: _ignored, ...restBody } = body;
        const tenantId = callerTenantId(req);
        const bl = await db.BillOfLading.create({
            ...restBody,
            id: restBody.id || genId(),
            bl_number: restBody.bl_number || genBlNumber(restBody.carrier_name || restBody.carrier_id),
            status: 'draft',
            ...(tenantId ? { tenant_id: tenantId } : {}),
        });
        return sendSuccess(req, res, bl, 201);
    } catch (err) { return next(err); }
};

// ── lifecycle actions ────────────────────────────────────────────────────────
// findOr404 enforces tenant ownership for all lifecycle mutations.
const findOr404 = async (req, next) => {
    return fetchBlOwned(req.params.id, req, next);
};

// draft → issued (carrier signs, title vests in the shipper).
const issue = async (req, res, next) => {
    try {
        const bl = await findOr404(req, next); if (!bl) return undefined;
        assertTransition(bl, 'issued');
        if (!holderName(bl.shipper) || !bl.goods_description) {
            return next(new AppError('BAD_REQUEST', 'shipper and goods_description are required to issue', 400));
        }
        const signature = providers.esign.sign({ documentId: bl.id, party: bl.carrier_name || bl.carrier_id || 'CARRIER', role: 'carrier' });
        await bl.update({
            status: 'issued',
            issued_at: new Date(),
            current_holder: holderName(bl.shipper),
            signatures: [...(bl.signatures || []), signature],
        });
        return sendSuccess(req, res, bl);
    } catch (err) { return next(err); }
};

// issued/transferred → transferred (endorse title to a new holder; negotiable B/Ls only).
const transfer = async (req, res, next) => {
    try {
        const bl = await findOr404(req, next); if (!bl) return undefined;
        assertTransition(bl, 'transferred');
        if (bl.bl_type !== 'negotiable') {
            return next(new AppError('NOT_NEGOTIABLE', `a '${bl.bl_type}' bill of lading is not transferable`, 409));
        }
        const toHolder = req.body && (req.body.toHolder || req.body.to_holder);
        if (!toHolder) return next(new AppError('BAD_REQUEST', 'toHolder is required', 400));
        const endorsedBy = (req.body && req.body.endorsedBy) || bl.current_holder;
        const endorsement = { from: bl.current_holder, to: toHolder, endorsedBy, at: new Date().toISOString() };
        await bl.update({
            status: 'transferred',
            current_holder: toHolder,
            holder_history: [...(bl.holder_history || []), endorsement],
        });
        return sendSuccess(req, res, bl);
    } catch (err) { return next(err); }
};

// issued/transferred → surrendered (holder surrenders the B/L to the carrier at destination).
const surrender = async (req, res, next) => {
    try {
        const bl = await findOr404(req, next); if (!bl) return undefined;
        assertTransition(bl, 'surrendered');
        const signature = providers.esign.sign({ documentId: bl.id, party: bl.current_holder || 'HOLDER', role: 'holder' });
        await bl.update({ status: 'surrendered', surrendered_at: new Date(), signatures: [...(bl.signatures || []), signature] });
        return sendSuccess(req, res, bl);
    } catch (err) { return next(err); }
};

// surrendered → released (carrier releases the cargo; advance the linked shipment if any).
const release = async (req, res, next) => {
    try {
        const bl = await findOr404(req, next); if (!bl) return undefined;
        assertTransition(bl, 'released');
        await bl.update({ status: 'released', released_at: new Date() });
        // Best-effort: mark the linked shipment released so cargo can be collected.
        if (bl.shipment_id) {
            try {
                const ship = await db.Shipment.findByPk(bl.shipment_id);
                if (ship && !['released', 'delivered', 'cancelled'].includes(ship.status)) {
                    await ship.update({ status: 'released' });
                    require('../realtime').publish(`shipment:${ship.id}`, 'status', { id: ship.id, status: 'released' }).catch(() => {});
                }
            } catch { /* non-fatal */ }
        }
        return sendSuccess(req, res, bl);
    } catch (err) { return next(err); }
};

// Add an e-signature (any party/role) without changing status.
const sign = async (req, res, next) => {
    try {
        const bl = await findOr404(req, next); if (!bl) return undefined;
        const party = req.body && req.body.party;
        const role = (req.body && req.body.role) || 'party';
        if (!party) return next(new AppError('BAD_REQUEST', 'party is required', 400));
        const signature = providers.esign.sign({ documentId: bl.id, party, role });
        await bl.update({ signatures: [...(bl.signatures || []), signature] });
        return sendSuccess(req, res, bl);
    } catch (err) { return next(err); }
};

const cancel = async (req, res, next) => {
    try {
        const bl = await findOr404(req, next); if (!bl) return undefined;
        assertTransition(bl, 'cancelled');
        await bl.update({ status: 'cancelled', metadata: { ...(bl.metadata || {}), cancelReason: (req.body && req.body.reason) || null } });
        return sendSuccess(req, res, bl);
    } catch (err) { return next(err); }
};

module.exports = { list, get, create, issue, transfer, surrender, release, sign, cancel };
