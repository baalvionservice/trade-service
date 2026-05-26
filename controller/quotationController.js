'use strict';
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listQuotations = async (req, res, next) => {
    try {
        const { rfqId, sellerId, status, page = 1, limit = 50 } = req.query;
        const org = req.auth && req.auth.orgCode;
        const isAdmin = req.auth && req.auth.role === 'admin';
        const where = {};
        if (rfqId) where.rfqId = rfqId;            // buyer viewing responses to an RFQ
        if (status) where.status = status;
        // Seller-ownership: a sellerId filter must match the caller's own org.
        if (sellerId) {
            if (!isAdmin && org && sellerId !== org) return next(new AppError('FORBIDDEN', 'Cannot view another seller\'s quotations', 403));
            where.sellerId = sellerId;
        } else if (!rfqId && !isAdmin) {
            // No rfq context + not admin → restrict to the caller's own quotes.
            where.sellerId = org || '__none__';
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Quotation.findAndCountAll({
            where, limit: Number(limit), offset, order: [['price', 'ASC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getQuotation = async (req, res, next) => {
    try {
        const quotation = await db.Quotation.findByPk(req.params.id);
        if (!quotation) return next(new AppError('NOT_FOUND', 'Quotation not found', 404));
        return sendSuccess(req, res, quotation);
    } catch (err) {
        return next(err);
    }
};

const createQuotation = async (req, res, next) => {
    try {
        const payload = { ...req.body };
        // Stamp the submitting seller's org so participant filtering is reliable.
        if (req.auth?.orgCode) payload.sellerId = String(req.auth.orgCode);
        else if (req.auth?.orgId) payload.sellerId = String(req.auth.orgId);
        const quotation = await db.Quotation.create(payload);
        return sendSuccess(req, res, quotation, 201);
    } catch (err) {
        return next(err);
    }
};

const updateQuotation = async (req, res, next) => {
    try {
        const quotation = await db.Quotation.findByPk(req.params.id);
        if (!quotation) return next(new AppError('NOT_FOUND', 'Quotation not found', 404));
        await quotation.update(req.body);
        return sendSuccess(req, res, quotation);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listQuotations, getQuotation, createQuotation, updateQuotation };
