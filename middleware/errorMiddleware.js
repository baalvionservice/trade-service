'use strict';
const { AppError } = require('../utils/errors');
const { sendError } = require('../utils/response');

const notFoundHandler = (req, res, next) =>
    next(new AppError('NOT_FOUND', 'Route not found', 404));

// Map Sequelize/Postgres data errors to precise 4xx codes so malformed client input
// NEVER surfaces as a 500. On a $-critical platform a 500 is an incident; a bad filter
// or payload must fail closed as a 400/409, with the true cause logged for ops.
const PG_INPUT_CODES = {
    '22P02': ['BAD_REQUEST', 400], // invalid_text_representation (bad enum / uuid / integer)
    '22007': ['BAD_REQUEST', 400], // invalid_datetime_format
    '22008': ['BAD_REQUEST', 400], // datetime_field_overflow
    '22003': ['BAD_REQUEST', 400], // numeric_value_out_of_range
    '23502': ['BAD_REQUEST', 400], // not_null_violation
    '23514': ['BAD_REQUEST', 400], // check_violation
    '23505': ['CONFLICT', 409],    // unique_violation
    '23503': ['CONFLICT', 409],    // foreign_key_violation
};

function classify(error) {
    if (error instanceof AppError) return error;

    const name = error && error.name;
    if (name === 'SequelizeValidationError') {
        const msg = (error.errors && error.errors[0] && error.errors[0].message) || 'Validation failed';
        return new AppError('BAD_REQUEST', msg, 400);
    }
    if (name === 'SequelizeUniqueConstraintError') {
        return new AppError('CONFLICT', 'Resource already exists', 409);
    }
    if (name === 'SequelizeForeignKeyConstraintError') {
        return new AppError('CONFLICT', 'Referenced resource does not exist', 409);
    }
    const pgCode = error && error.original && error.original.code;
    if (pgCode && PG_INPUT_CODES[pgCode]) {
        const [code, status] = PG_INPUT_CODES[pgCode];
        return new AppError(code, 'Invalid request parameter', status);
    }
    if (name === 'SequelizeDatabaseError') {
        // Unknown DB error — treat as bad input rather than leaking a 500, but log it.
        return new AppError('BAD_REQUEST', 'Invalid request', 400);
    }
    return new AppError('INTERNAL_SERVER_ERROR', error.message || 'Server error', 500);
}

const errorHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const n = classify(error);
    // Log genuine server faults (and the underlying cause for mapped 4xx) for observability.
    if (n.statusCode >= 500 || !(error instanceof AppError)) {
        const level = n.statusCode >= 500 ? 'error' : 'warn';
        console[level](`[trade-service] ${n.statusCode} ${req.method} ${req.originalUrl} — ${error.name || 'Error'}: ${error.message}`);
    }
    return sendError(req, res, n);
};

module.exports = { notFoundHandler, errorHandler };
