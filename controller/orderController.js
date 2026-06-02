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

async function fetchOrderOwned(id, req, next) {
    const order = await db.Order.findByPk(id);
    if (!order) { next(new AppError('NOT_FOUND', 'Order not found', 404)); return null; }
    if (isAdmin(req)) return order;
    const tenantId = callerTenantId(req);
    if (tenantId && order.tenant_id && order.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Order not found', 404)); return null;
    }
    return order;
}

const listOrders = async (req, res, next) => {
    try {
        const { status, deal_id, buyer_org_id, seller_org_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (deal_id) where.deal_id = deal_id;
        if (buyer_org_id) where.buyer_org_id = buyer_org_id;
        if (seller_org_id) where.seller_org_id = seller_org_id;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Order.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getOrder = async (req, res, next) => {
    try {
        const order = await fetchOrderOwned(req.params.id, req, next);
        if (!order) return undefined;
        return sendSuccess(req, res, order);
    } catch (err) {
        return next(err);
    }
};

const createOrder = async (req, res, next) => {
    try {
        const { tenant_id: _ignored, ...body } = req.body || {};
        const tenantId = callerTenantId(req);
        const order = await db.Order.create({ ...body, ...(tenantId ? { tenant_id: tenantId } : {}) });
        return sendSuccess(req, res, order, 201);
    } catch (err) {
        return next(err);
    }
};

const updateOrder = async (req, res, next) => {
    try {
        const order = await fetchOrderOwned(req.params.id, req, next);
        if (!order) return undefined;
        // Strip any client-supplied tenant_id from updates.
        const { tenant_id: _ignored, ...updates } = req.body || {};
        await order.update(updates);
        return sendSuccess(req, res, order);
    } catch (err) {
        return next(err);
    }
};

const updateOrderStatus = async (req, res, next) => {
    try {
        const order = await fetchOrderOwned(req.params.id, req, next);
        if (!order) return undefined;
        const { status } = req.body;
        if (!status) return next(new AppError('BAD_REQUEST', 'status is required', 400));
        await order.update({ status });
        return sendSuccess(req, res, order);
    } catch (err) {
        return next(err);
    }
};

const updateOrderFulfillment = async (req, res, next) => {
    try {
        const order = await fetchOrderOwned(req.params.id, req, next);
        if (!order) return undefined;
        const { fulfillment_state } = req.body;
        if (!fulfillment_state) return next(new AppError('BAD_REQUEST', 'fulfillment_state is required', 400));
        await order.update({ fulfillment_state });
        return sendSuccess(req, res, order);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listOrders, getOrder, createOrder, updateOrder, updateOrderStatus, updateOrderFulfillment };
