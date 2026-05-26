'use strict';
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');
const { isDealParticipant } = require('../middleware/participantAuth');

// A deal-room message is only accessible to participants of its parent deal.
const assertRoomAccess = async (req, dealId) => {
    if (!dealId) throw new AppError('BAD_REQUEST', 'dealId is required', 400);
    const deal = await db.Deal.findByPk(dealId);
    if (!deal || !isDealParticipant(req, deal)) throw new AppError('NOT_FOUND', 'Deal room not found', 404);
    return deal;
};

const listMessages = async (req, res, next) => {
    try {
        const { dealId, type, page = 1, limit = 200 } = req.query;
        await assertRoomAccess(req, dealId); // participant gate
        const where = { dealId };
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
        await assertRoomAccess(req, req.body && req.body.dealId); // participant gate
        const message = await db.Message.create(req.body);
        // Realtime push to the deal room (best-effort, non-blocking).
        require('../realtime').publish(`deal:${message.dealId}`, 'message', message).catch(() => {});
        return sendSuccess(req, res, message, 201);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listMessages, createMessage };
