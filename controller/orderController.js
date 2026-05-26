'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listOrders = async (req, res, next) => {
    try {
        const { status, deal_id, buyer_org_id, seller_org_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (deal_id) where.deal_id = deal_id;
        if (buyer_org_id) where.buyer_org_id = buyer_org_id;
        if (seller_org_id) where.seller_org_id = seller_org_id;
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
        const order = await db.Order.findByPk(req.params.id);
        if (!order) return next(new AppError('NOT_FOUND', 'Order not found', 404));
        return sendSuccess(req, res, order);
    } catch (err) {
        return next(err);
    }
};

const createOrder = async (req, res, next) => {
    try {
        const order = await db.Order.create(req.body);
        return sendSuccess(req, res, order, 201);
    } catch (err) {
        return next(err);
    }
};

const updateOrder = async (req, res, next) => {
    try {
        const order = await db.Order.findByPk(req.params.id);
        if (!order) return next(new AppError('NOT_FOUND', 'Order not found', 404));
        await order.update(req.body);
        return sendSuccess(req, res, order);
    } catch (err) {
        return next(err);
    }
};

const updateOrderStatus = async (req, res, next) => {
    try {
        const order = await db.Order.findByPk(req.params.id);
        if (!order) return next(new AppError('NOT_FOUND', 'Order not found', 404));
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
        const order = await db.Order.findByPk(req.params.id);
        if (!order) return next(new AppError('NOT_FOUND', 'Order not found', 404));
        const { fulfillment_state } = req.body;
        if (!fulfillment_state) return next(new AppError('BAD_REQUEST', 'fulfillment_state is required', 400));
        await order.update({ fulfillment_state });
        return sendSuccess(req, res, order);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listOrders, getOrder, createOrder, updateOrder, updateOrderStatus, updateOrderFulfillment };
