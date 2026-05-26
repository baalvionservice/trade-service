'use strict';
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');

const listMessages = async (req, res, next) => {
    try {
        const { dealId, type, page = 1, limit = 200 } = req.query;
        const where = {};
        if (dealId) where.dealId = dealId;
        if (type) where.type = type;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Message.findAndCountAll({
            where, limit: Number(limit), offset, order: [['createdAt', 'ASC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const createMessage = async (req, res, next) => {
    try {
        const message = await db.Message.create(req.body);
        return sendSuccess(req, res, message, 201);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listMessages, createMessage };
