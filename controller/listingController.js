'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listListings = async (req, res, next) => {
    try {
        const { category, type, companyId, status = 'active', search, page = 1, limit = 50 } = req.query;
        const where = {};
        if (category) where.category = category;
        if (type) where.type = type;
        if (companyId) where.companyId = companyId;
        if (status) where.status = status;
        if (search) where.title = { [Op.iLike]: `%${search}%` };
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Listing.findAndCountAll({
            where, limit: Number(limit), offset, order: [['createdAt', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getListing = async (req, res, next) => {
    try {
        const listing = await db.Listing.findByPk(req.params.id);
        if (!listing) return next(new AppError('NOT_FOUND', 'Listing not found', 404));
        return sendSuccess(req, res, listing);
    } catch (err) {
        return next(err);
    }
};

const createListing = async (req, res, next) => {
    try {
        // Bind the listing to the authenticated org when available.
        const payload = { ...req.body };
        if (req.auth?.orgId) payload.companyId = String(req.auth.orgId);
        const listing = await db.Listing.create(payload);
        return sendSuccess(req, res, listing, 201);
    } catch (err) {
        return next(err);
    }
};

const updateListing = async (req, res, next) => {
    try {
        const listing = await db.Listing.findByPk(req.params.id);
        if (!listing) return next(new AppError('NOT_FOUND', 'Listing not found', 404));
        await listing.update(req.body);
        return sendSuccess(req, res, listing);
    } catch (err) {
        return next(err);
    }
};

const deleteListing = async (req, res, next) => {
    try {
        const listing = await db.Listing.findByPk(req.params.id);
        if (!listing) return next(new AppError('NOT_FOUND', 'Listing not found', 404));
        await listing.destroy();
        return sendSuccess(req, res, { deleted: true });
    } catch (err) {
        return next(err);
    }
};

module.exports = { listListings, getListing, createListing, updateListing, deleteListing };
