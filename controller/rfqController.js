'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || [];
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}

function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}

// For write operations on RFQs (update/close/award), enforce that the caller owns the record.
// RFQ is marketplace-visible (list/get are public) but mutations are owner-only.
async function fetchRfqOwned(id, req, next) {
    const rfq = await db.Rfq.findByPk(id);
    if (!rfq) { next(new AppError('NOT_FOUND', 'RFQ not found', 404)); return null; }
    if (isAdmin(req)) return rfq;
    const tenantId = callerTenantId(req);
    if (tenantId && rfq.tenant_id && rfq.tenant_id !== tenantId) {
        next(new AppError('FORBIDDEN', 'You do not have permission to modify this RFQ', 403)); return null;
    }
    return rfq;
}

// list/get are intentionally public (cross-tenant marketplace discovery — see models/index.js TENANT_EXCLUDED comment).
const listRfqs = async (req, res, next) => {
    try {
        const { status, buyer_org_id, commodity, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (buyer_org_id) where.buyer_org_id = buyer_org_id;
        if (commodity) where.commodity = { [Op.iLike]: `%${commodity}%` };
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Rfq.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getRfq = async (req, res, next) => {
    try {
        const rfq = await db.Rfq.findByPk(req.params.id);
        if (!rfq) return next(new AppError('NOT_FOUND', 'RFQ not found', 404));
        return sendSuccess(req, res, rfq);
    } catch (err) {
        return next(err);
    }
};

const createRfq = async (req, res, next) => {
    try {
        // Stamp tenant_id from server context; never accept from client.
        const { tenant_id: _ignored, ...body } = req.body || {};
        const tenantId = callerTenantId(req);
        const rfq = await db.Rfq.create({ ...body, ...(tenantId ? { tenant_id: tenantId } : {}) });
        return sendSuccess(req, res, rfq, 201);
    } catch (err) {
        return next(err);
    }
};

const updateRfq = async (req, res, next) => {
    try {
        const rfq = await fetchRfqOwned(req.params.id, req, next);
        if (!rfq) return undefined;
        const { tenant_id: _ignored, ...updates } = req.body || {};
        await rfq.update(updates);
        return sendSuccess(req, res, rfq);
    } catch (err) {
        return next(err);
    }
};

const closeRfq = async (req, res, next) => {
    try {
        const rfq = await fetchRfqOwned(req.params.id, req, next);
        if (!rfq) return undefined;
        await rfq.update({ status: 'closed' });
        return sendSuccess(req, res, rfq);
    } catch (err) {
        return next(err);
    }
};

const awardRfq = async (req, res, next) => {
    try {
        const rfq = await fetchRfqOwned(req.params.id, req, next);
        if (!rfq) return undefined;
        // status=awarded signals the RFQ has been awarded; the winning seller is captured in the resulting Deal
        await rfq.update({ status: 'awarded' });
        return sendSuccess(req, res, rfq);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listRfqs, getRfq, createRfq, updateRfq, closeRfq, awardRfq };
