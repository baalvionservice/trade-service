'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listDeals = async (req, res, next) => {
    try {
        const { status, buyer_org_id, seller_org_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (buyer_org_id) where.buyer_org_id = buyer_org_id;
        if (seller_org_id) where.seller_org_id = seller_org_id;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Deal.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getDeal = async (req, res, next) => {
    try {
        const deal = await db.Deal.findByPk(req.params.id);
        if (!deal) return next(new AppError('NOT_FOUND', 'Deal not found', 404));
        return sendSuccess(req, res, deal);
    } catch (err) {
        return next(err);
    }
};

const createDeal = async (req, res, next) => {
    try {
        const deal = await db.Deal.create(req.body);
        return sendSuccess(req, res, deal, 201);
    } catch (err) {
        return next(err);
    }
};

const updateDeal = async (req, res, next) => {
    try {
        const deal = await db.Deal.findByPk(req.params.id);
        if (!deal) return next(new AppError('NOT_FOUND', 'Deal not found', 404));
        await deal.update(req.body);
        return sendSuccess(req, res, deal);
    } catch (err) {
        return next(err);
    }
};

const finalizeDeal = async (req, res, next) => {
    try {
        const deal = await db.Deal.findByPk(req.params.id);
        if (!deal) return next(new AppError('NOT_FOUND', 'Deal not found', 404));
        await deal.update({ status: 'finalized', signed_at: new Date() });
        return sendSuccess(req, res, deal);
    } catch (err) {
        return next(err);
    }
};

const commitDeal = async (req, res, next) => {
    try {
        const deal = await db.Deal.findByPk(req.params.id);
        if (!deal) return next(new AppError('NOT_FOUND', 'Deal not found', 404));
        await deal.update({ status: 'committed' });
        return sendSuccess(req, res, deal);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listDeals, getDeal, createDeal, updateDeal, finalizeDeal, commitDeal };
