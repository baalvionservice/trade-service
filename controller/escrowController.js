'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

// Returns true if the caller is an admin/super_admin who bypasses tenant scoping.
function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || [];
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}

// Derive the server-side tenant from req.auth (set by authMiddleware from the verified
// gateway identity). Never trust req.body / req.query / req.params for tenant identity.
function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}

// Fetch an Escrow by PK and enforce tenant ownership.
// Returns the record or calls next(err) and returns null.
async function fetchEscrowOwned(id, req, next) {
    const escrow = await db.Escrow.findByPk(id);
    if (!escrow) { next(new AppError('NOT_FOUND', 'Escrow not found', 404)); return null; }
    // Admin bypass: admins/super_admins see all tenants.
    if (isAdmin(req)) return escrow;
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
        // Tenant scoping on list: beforeFind hook handles this, but be explicit for findAndCountAll.
        if (!isAdmin(req)) {
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
        return sendSuccess(req, res, escrow, 201);
    } catch (err) {
        return next(err);
    }
};

const fundEscrow = async (req, res, next) => {
    try {
        const escrow = await fetchEscrowOwned(req.params.id, req, next);
        if (!escrow) return undefined;
        await escrow.update({ status: 'funded', funded_at: new Date() });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

const releaseEscrow = async (req, res, next) => {
    try {
        const escrow = await fetchEscrowOwned(req.params.id, req, next);
        if (!escrow) return undefined;
        await escrow.update({ status: 'released', released_at: new Date() });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

const refundEscrow = async (req, res, next) => {
    try {
        const escrow = await fetchEscrowOwned(req.params.id, req, next);
        if (!escrow) return undefined;
        await escrow.update({ status: 'refunded' });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listEscrows, getEscrow, createEscrow, fundEscrow, releaseEscrow, refundEscrow };
