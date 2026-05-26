'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listEscrows = async (req, res, next) => {
    try {
        const { order_id, status, page = 1, limit = 20 } = req.query;
        const where = {};
        if (order_id) where.order_id = order_id;
        if (status) where.status = status;
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
        const escrow = await db.Escrow.findByPk(req.params.id);
        if (!escrow) return next(new AppError('NOT_FOUND', 'Escrow not found', 404));
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

const createEscrow = async (req, res, next) => {
    try {
        const escrow = await db.Escrow.create(req.body);
        return sendSuccess(req, res, escrow, 201);
    } catch (err) {
        return next(err);
    }
};

const fundEscrow = async (req, res, next) => {
    try {
        const escrow = await db.Escrow.findByPk(req.params.id);
        if (!escrow) return next(new AppError('NOT_FOUND', 'Escrow not found', 404));
        await escrow.update({ status: 'funded', funded_at: new Date() });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

const releaseEscrow = async (req, res, next) => {
    try {
        const escrow = await db.Escrow.findByPk(req.params.id);
        if (!escrow) return next(new AppError('NOT_FOUND', 'Escrow not found', 404));
        await escrow.update({ status: 'released', released_at: new Date() });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

const refundEscrow = async (req, res, next) => {
    try {
        const escrow = await db.Escrow.findByPk(req.params.id);
        if (!escrow) return next(new AppError('NOT_FOUND', 'Escrow not found', 404));
        await escrow.update({ status: 'refunded' });
        return sendSuccess(req, res, escrow);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listEscrows, getEscrow, createEscrow, fundEscrow, releaseEscrow, refundEscrow };
