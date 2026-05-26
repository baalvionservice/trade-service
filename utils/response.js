'use strict';
const { v4: uuidv4 } = require('uuid');

const buildMeta = (req, extra = {}) => ({
    requestId: req.requestId || uuidv4(),
    timestamp: new Date().toISOString(),
    version: 'v1',
    ...extra,
});

const sendSuccess = (req, res, data, status = 200, meta = {}) =>
    res.status(status).json({ success: true, data, meta: buildMeta(req, meta) });

const sendPaginated = (req, res, payload) =>
    res.status(200).json({ success: true, data: payload, meta: buildMeta(req) });

const sendError = (req, res, error) =>
    res.status(error.statusCode || 500).json({
        success: false,
        error: {
            code: error.code || 'INTERNAL_SERVER_ERROR',
            message: error.message,
            details: error.details || {},
            requestId: req.requestId,
        },
    });

module.exports = { sendSuccess, sendPaginated, sendError };
