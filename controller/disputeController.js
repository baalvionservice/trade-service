'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listDisputes = async (req, res, next) => {
    try {
        const { status, order_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (order_id) where.order_id = order_id;
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
        const dispute = await db.Dispute.findByPk(req.params.id);
        if (!dispute) return next(new AppError('NOT_FOUND', 'Dispute not found', 404));
        return sendSuccess(req, res, dispute);
    } catch (err) {
        return next(err);
    }
};

const createDispute = async (req, res, next) => {
    try {
        const dispute = await db.Dispute.create(req.body);
        return sendSuccess(req, res, dispute, 201);
    } catch (err) {
        return next(err);
    }
};

const updateDispute = async (req, res, next) => {
    try {
        const dispute = await db.Dispute.findByPk(req.params.id);
        if (!dispute) return next(new AppError('NOT_FOUND', 'Dispute not found', 404));
        await dispute.update(req.body);
        return sendSuccess(req, res, dispute);
    } catch (err) {
        return next(err);
    }
};

const addEvidence = async (req, res, next) => {
    try {
        const dispute = await db.Dispute.findByPk(req.params.id);
        if (!dispute) return next(new AppError('NOT_FOUND', 'Dispute not found', 404));
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
        const dispute = await db.Dispute.findByPk(req.params.id);
        if (!dispute) return next(new AppError('NOT_FOUND', 'Dispute not found', 404));
        const { resolution } = req.body;
        await dispute.update({ status: 'resolved', resolution: resolution || null, resolved_at: new Date() });
        return sendSuccess(req, res, dispute);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listDisputes, getDispute, createDispute, updateDispute, addEvidence, resolveDispute };
