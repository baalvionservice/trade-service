'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listCases = async (req, res, next) => {
    try {
        const { status, risk_level, entity_type, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (risk_level) where.risk_level = risk_level;
        if (entity_type) where.entity_type = entity_type;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.ComplianceCase.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getCase = async (req, res, next) => {
    try {
        const cc = await db.ComplianceCase.findByPk(req.params.id);
        if (!cc) return next(new AppError('NOT_FOUND', 'Compliance case not found', 404));
        return sendSuccess(req, res, cc);
    } catch (err) {
        return next(err);
    }
};

const createCase = async (req, res, next) => {
    try {
        const cc = await db.ComplianceCase.create(req.body);
        return sendSuccess(req, res, cc, 201);
    } catch (err) {
        return next(err);
    }
};

const updateCase = async (req, res, next) => {
    try {
        const cc = await db.ComplianceCase.findByPk(req.params.id);
        if (!cc) return next(new AppError('NOT_FOUND', 'Compliance case not found', 404));
        await cc.update(req.body);
        return sendSuccess(req, res, cc);
    } catch (err) {
        return next(err);
    }
};

const clearCase = async (req, res, next) => {
    try {
        const cc = await db.ComplianceCase.findByPk(req.params.id);
        if (!cc) return next(new AppError('NOT_FOUND', 'Compliance case not found', 404));
        await cc.update({ status: 'cleared', resolved_at: new Date() });
        return sendSuccess(req, res, cc);
    } catch (err) {
        return next(err);
    }
};

const escalateCase = async (req, res, next) => {
    try {
        const cc = await db.ComplianceCase.findByPk(req.params.id);
        if (!cc) return next(new AppError('NOT_FOUND', 'Compliance case not found', 404));
        await cc.update({ status: 'escalated' });
        return sendSuccess(req, res, cc);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listCases, getCase, createCase, updateCase, clearCase, escalateCase };
