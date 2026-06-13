'use strict';
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');
const { recordAudit } = require('../utils/audit');
const {
    hasPlatformBypass, callerTenantId, actorId, evaluateDualControl,
} = require('../utils/financialControls');

// Fetch an Escrow by PK and enforce tenant ownership.
// Returns the record or calls next(err) and returns null.
//
// War Room 3: tenant bypass is reserved for PLATFORM operators only. An org
// admin/owner is tenant-scoped on financial records — they may NOT read or move
// another tenant's escrow. (Role to MOVE money is enforced at the route.)
async function fetchEscrowOwned(id, req, next) {
    const escrow = await db.Escrow.findByPk(id);
    if (!escrow) { next(new AppError('NOT_FOUND', 'Escrow not found', 404)); return null; }
    if (hasPlatformBypass(req)) return escrow;
    const tenantId = callerTenantId(req);
    if (tenantId && escrow.tenant_id && escrow.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Escrow not found', 404)); return null;
    }
    return escrow;
}

const listEscrows = async (req, res, next) => {
    try {
        const { order_id, status, page = 1, limit = 20 } = req.query;
        const where = {};
        if (order_id) where.order_id = order_id;
        if (status) where.status = status;
        // Tenant scoping on list: platform operators see all tenants; everyone else
        // is constrained to their own tenant.
        if (!hasPlatformBypass(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Escrow.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getEscrow = async (req, res, next) => {
    try {
        const escrow = await fetchEscrowOwned(req.params.id, req, next);
        if (!escrow) return undefined;
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

const createEscrow = async (req, res, next) => {
    try {
        // Strip any client-supplied tenant_id; stamp from server context instead.
        const { tenant_id: _ignored, ...body } = req.body || {};
        const tenantId = callerTenantId(req);
        const escrow = await db.Escrow.create({ ...body, ...(tenantId ? { tenant_id: tenantId } : {}) });
        await recordAudit({
            actorId: actorId(req), action: 'escrow.create', resourceType: 'escrow', resourceId: escrow.id,
            tenantId: tenantId || escrow.tenant_id,
            metadata: { amount: escrow.amount, currency: escrow.currency, order_id: escrow.order_id, status: escrow.status },
        });
        return sendSuccess(req, res, escrow, 201);
    } catch (err) {
        return next(err);
    }
};

const fundEscrow = async (req, res, next) => {
    try {
        const escrow = await fetchEscrowOwned(req.params.id, req, next);
        if (!escrow) return undefined;
        const before = escrow.status;
        await escrow.update({ status: 'funded', funded_at: new Date() });
        await recordAudit({
            actorId: actorId(req), action: 'escrow.fund', resourceType: 'escrow', resourceId: escrow.id,
            tenantId: escrow.tenant_id,
            metadata: { amount: escrow.amount, currency: escrow.currency, before, after: 'funded' },
        });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

const releaseEscrow = async (req, res, next) => {
    try {
        const escrow = await fetchEscrowOwned(req.params.id, req, next);
        if (!escrow) return undefined;

        // Dual control on large releases (maker-checker). State is persisted in the
        // existing release_conditions JSONB so no migration is required.
        const dc = evaluateDualControl({
            state: escrow.release_conditions || {},
            amount: escrow.amount, currency: escrow.currency, action: 'release', req,
        });
        if (dc.decision === 'await_approval') {
            await escrow.update({ release_conditions: dc.nextState });
            await recordAudit({
                actorId: actorId(req), action: 'escrow.release.requested', resourceType: 'escrow', resourceId: escrow.id,
                tenantId: escrow.tenant_id,
                metadata: { amount: escrow.amount, currency: escrow.currency, requires_second_approver: true },
            });
            return sendSuccess(req, res, { ...escrow.toJSON(), pending_approval: true }, 202);
        }

        const before = escrow.status;
        await escrow.update({ status: 'released', released_at: new Date(), release_conditions: dc.nextState });
        await recordAudit({
            actorId: actorId(req), action: 'escrow.release', resourceType: 'escrow', resourceId: escrow.id,
            tenantId: escrow.tenant_id,
            metadata: {
                amount: escrow.amount, currency: escrow.currency, before, after: 'released',
                dual_control: dc.nextState.dual_control || null,
            },
        });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

const refundEscrow = async (req, res, next) => {
    try {
        const escrow = await fetchEscrowOwned(req.params.id, req, next);
        if (!escrow) return undefined;

        const dc = evaluateDualControl({
            state: escrow.release_conditions || {},
            amount: escrow.amount, currency: escrow.currency, action: 'refund', req,
        });
        if (dc.decision === 'await_approval') {
            await escrow.update({ release_conditions: dc.nextState });
            await recordAudit({
                actorId: actorId(req), action: 'escrow.refund.requested', resourceType: 'escrow', resourceId: escrow.id,
                tenantId: escrow.tenant_id,
                metadata: { amount: escrow.amount, currency: escrow.currency, requires_second_approver: true },
            });
            return sendSuccess(req, res, { ...escrow.toJSON(), pending_approval: true }, 202);
        }

        const before = escrow.status;
        await escrow.update({ status: 'refunded', release_conditions: dc.nextState });
        await recordAudit({
            actorId: actorId(req), action: 'escrow.refund', resourceType: 'escrow', resourceId: escrow.id,
            tenantId: escrow.tenant_id,
            metadata: {
                amount: escrow.amount, currency: escrow.currency, before, after: 'refunded',
                dual_control: dc.nextState.dual_control || null,
            },
        });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listEscrows, getEscrow, createEscrow, fundEscrow, releaseEscrow, refundEscrow };
