'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listOrgs = async (req, res, next) => {
    try {
        const { type, country, status, search, page = 1, limit = 20 } = req.query;
        const where = {};
        if (type) where.type = type;
        if (country) where.country = country;
        if (status) where.status = status;
        if (search) where.name = { [Op.iLike]: `%${search}%` };
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Organization.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getOrg = async (req, res, next) => {
    try {
        const org = await db.Organization.findByPk(req.params.id);
        if (!org) return next(new AppError('NOT_FOUND', 'Organization not found', 404));
        return sendSuccess(req, res, org);
    } catch (err) {
        return next(err);
    }
};

const createOrg = async (req, res, next) => {
    try {
        const org = await db.Organization.create(req.body);
        return sendSuccess(req, res, org, 201);
    } catch (err) {
        return next(err);
    }
};

const updateOrg = async (req, res, next) => {
    try {
        const org = await db.Organization.findByPk(req.params.id);
        if (!org) return next(new AppError('NOT_FOUND', 'Organization not found', 404));
        await org.update(req.body);
        return sendSuccess(req, res, org);
    } catch (err) {
        return next(err);
    }
};

const deleteOrg = async (req, res, next) => {
    try {
        const org = await db.Organization.findByPk(req.params.id);
        if (!org) return next(new AppError('NOT_FOUND', 'Organization not found', 404));
        await org.destroy();
        return sendSuccess(req, res, { deleted: true });
    } catch (err) {
        return next(err);
    }
};

const updateKyc = async (req, res, next) => {
    try {
        const org = await db.Organization.findByPk(req.params.id);
        if (!org) return next(new AppError('NOT_FOUND', 'Organization not found', 404));
        const { kyc_status, risk_score } = req.body;
        await org.update({ kyc_status, risk_score });
        return sendSuccess(req, res, org);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listOrgs, getOrg, createOrg, updateOrg, deleteOrg, updateKyc };
