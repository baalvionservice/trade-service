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

async function fetchDisputeOwned(id, req, next) {
    const dispute = await db.Dispute.findByPk(id);
    if (!dispute) { next(new AppError('NOT_FOUND', 'Dispute not found', 404)); return null; }
    if (isAdmin(req)) return dispute;
    const tenantId = callerTenantId(req);
    if (tenantId && dispute.tenant_id && dispute.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Dispute not found', 404)); return null;
    }
    return dispute;
}

const listDisputes = async (req, res, next) => {
    try {
        const { status, order_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (order_id) where.order_id = order_id;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Dispute.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getDispute = async (req, res, next) => {
    try {
        const dispute = await fetchDisputeOwned(req.params.id, req, next);
        if (!dispute) return undefined;
        return sendSuccess(req, res, dispute);
    } catch (err) {
        return next(err);
    }
};

const createDispute = async (req, res, next) => {
    try {
        const { tenant_id: _ignored, ...body } = req.body || {};
        const tenantId = callerTenantId(req);
        const dispute = await db.Dispute.create({ ...body, ...(tenantId ? { tenant_id: tenantId } : {}) });
        return sendSuccess(req, res, dispute, 201);
    } catch (err) {
        return next(err);
    }
};

const updateDispute = async (req, res, next) => {
    try {
        const dispute = await fetchDisputeOwned(req.params.id, req, next);
        if (!dispute) return undefined;
        const { tenant_id: _ignored, ...updates } = req.body || {};
        await dispute.update(updates);
        return sendSuccess(req, res, dispute);
    } catch (err) {
        return next(err);
    }
};

const addEvidence = async (req, res, next) => {
    try {
        const dispute = await fetchDisputeOwned(req.params.id, req, next);
        if (!dispute) return undefined;
        const item = { ...req.body, submitted_at: req.body.submitted_at || new Date().toISOString() };
        const evidence = [...(dispute.evidence || []), item];
        await dispute.update({ evidence });
        return sendSuccess(req, res, dispute, 201);
    } catch (err) {
        return next(err);
    }
};

const resolveDispute = async (req, res, next) => {
    try {
        const dispute = await fetchDisputeOwned(req.params.id, req, next);
        if (!dispute) return undefined;
        const { resolution } = req.body;
        await dispute.update({ status: 'resolved', resolution: resolution || null, resolved_at: new Date() });
        return sendSuccess(req, res, dispute);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listDisputes, getDispute, createDispute, updateDispute, addEvidence, resolveDispute };
