'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

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
        const rfq = await db.Rfq.create(req.body);
        return sendSuccess(req, res, rfq, 201);
    } catch (err) {
        return next(err);
    }
};

const updateRfq = async (req, res, next) => {
    try {
        const rfq = await db.Rfq.findByPk(req.params.id);
        if (!rfq) return next(new AppError('NOT_FOUND', 'RFQ not found', 404));
        await rfq.update(req.body);
        return sendSuccess(req, res, rfq);
    } catch (err) {
        return next(err);
    }
};

const closeRfq = async (req, res, next) => {
    try {
        const rfq = await db.Rfq.findByPk(req.params.id);
        if (!rfq) return next(new AppError('NOT_FOUND', 'RFQ not found', 404));
        await rfq.update({ status: 'closed' });
        return sendSuccess(req, res, rfq);
    } catch (err) {
        return next(err);
    }
};

const awardRfq = async (req, res, next) => {
    try {
        const rfq = await db.Rfq.findByPk(req.params.id);
        if (!rfq) return next(new AppError('NOT_FOUND', 'RFQ not found', 404));
        // status=awarded signals the RFQ has been awarded; the winning seller is captured in the resulting Deal
        await rfq.update({ status: 'awarded' });
        return sendSuccess(req, res, rfq);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listRfqs, getRfq, createRfq, updateRfq, closeRfq, awardRfq };
