'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listNotifications = async (req, res, next) => {
    try {
        const { recipient_org_id, is_read, page = 1, limit = 20 } = req.query;
        const where = {};
        if (recipient_org_id) where.recipient_org_id = recipient_org_id;
        if (is_read !== undefined) where.is_read = is_read === 'true';
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Notification.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const markRead = async (req, res, next) => {
    try {
        const notification = await db.Notification.findByPk(req.params.id);
        if (!notification) return next(new AppError('NOT_FOUND', 'Notification not found', 404));
        await notification.update({ is_read: true });
        return sendSuccess(req, res, notification);
    } catch (err) {
        return next(err);
    }
};

const markAllRead = async (req, res, next) => {
    try {
        const { recipient_org_id } = req.body;
        const where = { is_read: false };
        if (recipient_org_id) where.recipient_org_id = recipient_org_id;
        const [affectedCount] = await db.Notification.update({ is_read: true }, { where });
        return sendSuccess(req, res, { updated: affectedCount });
    } catch (err) {
        return next(err);
    }
};

module.exports = { listNotifications, markRead, markAllRead };
