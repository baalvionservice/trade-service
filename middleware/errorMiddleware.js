'use strict';
const { AppError } = require('../utils/errors');
const { sendError } = require('../utils/response');

const notFoundHandler = (req, res, next) =>
    next(new AppError('NOT_FOUND', 'Route not found', 404));

const errorHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const n = error instanceof AppError
        ? error
        : new AppError('INTERNAL_SERVER_ERROR', error.message || 'Server error', 500);
    return sendError(req, res, n);
};

module.exports = { notFoundHandler, errorHandler };
