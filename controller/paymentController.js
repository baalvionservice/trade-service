'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listPayments = async (req, res, next) => {
    try {
        const { order_id, status, payer_org_id, payee_org_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (order_id) where.order_id = order_id;
        if (status) where.status = status;
        if (payer_org_id) where.payer_org_id = payer_org_id;
        if (payee_org_id) where.payee_org_id = payee_org_id;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Payment.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getPayment = async (req, res, next) => {
    try {
        const payment = await db.Payment.findByPk(req.params.id);
        if (!payment) return next(new AppError('NOT_FOUND', 'Payment not found', 404));
        return sendSuccess(req, res, payment);
    } catch (err) {
        return next(err);
    }
};

const createPayment = async (req, res, next) => {
    try {
        const payment = await db.Payment.create(req.body);
        return sendSuccess(req, res, payment, 201);
    } catch (err) {
        return next(err);
    }
};

const updatePaymentStatus = async (req, res, next) => {
    try {
        const payment = await db.Payment.findByPk(req.params.id);
        if (!payment) return next(new AppError('NOT_FOUND', 'Payment not found', 404));
        const { status, settled_at } = req.body;
        if (!status) return next(new AppError('BAD_REQUEST', 'status is required', 400));
        const updates = { status };
        if (status === 'completed' && !settled_at) updates.settled_at = new Date();
        if (settled_at) updates.settled_at = settled_at;
        await payment.update(updates);
        return sendSuccess(req, res, payment);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listPayments, getPayment, createPayment, updatePaymentStatus };
