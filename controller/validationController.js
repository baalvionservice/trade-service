'use strict';
// AI Document Validation Engine — HTTP surface (Prompt 5).
// Thin controller: validation + tenant ownership + delegation to the engine.
const db = require('../models');
const engine = require('../service/validation/validationEngine');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || [];
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}
function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}
function actorOf(req) {
    return (req.auth && (req.auth.userId || req.auth.email)) || 'system';
}

// ── POST /v1/document_validations/validate ───────────────────────────────────
// Stateless: validate an explicit payload, return the report. No persistence.
const validatePayload = async (req, res, next) => {
    try {
        const { document = {}, extracted = {}, expected = {}, options = {} } = req.body || {};
        if (typeof extracted !== 'object' || Array.isArray(extracted)) {
            return next(new AppError('INVALID_EXTRACTED', '`extracted` must be an object', 422));
        }
        const report = await engine.validatePayload({ document, extracted, expected, options });
        return sendSuccess(req, res, { validation_report: report });
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/document_validations ────────────────────────────────────────────
// Document-bound: load a stored document, validate against its trade-operation /
// sibling-document context, persist the report, return it.
const validateDocument = async (req, res, next) => {
    try {
        const {
            document_id, kind = 'tradeops_document', expected_override = {}, options = {}, persist = true,
        } = req.body || {};
        if (!document_id) return next(new AppError('DOCUMENT_ID_REQUIRED', '`document_id` is required', 422));

        const tenantId = callerTenantId(req);
        const { report, record } = await engine.validateDocument({
            documentId: document_id,
            kind,
            expectedOverride: expected_override,
            options,
            actor: actorOf(req),
            persist: persist !== false,
        });

        // Tenant ownership guard (defense in depth on top of RLS).
        if (record && !isAdmin(req) && tenantId && record.tenant_id && record.tenant_id !== tenantId) {
            return next(new AppError('FORBIDDEN', 'Document belongs to another tenant', 403));
        }

        return sendSuccess(req, res, {
            validation_report: report,
            validation_id: record ? record.id : null,
        }, 201);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/document_validations ─────────────────────────────────────────────
const listValidations = async (req, res, next) => {
    try {
        const {
            document_ref, document_kind, trade_operation_id, status, page = 1, limit = 20,
        } = req.query;
        const where = {};
        if (document_ref) where.document_ref = String(document_ref);
        if (document_kind) where.document_kind = document_kind;
        if (trade_operation_id) where.trade_operation_id = trade_operation_id;
        if (status) where.status = status;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.DocumentValidation.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, {
            items: rows, total: count, page: Number(page), limit: Number(limit),
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/document_validations/:id ─────────────────────────────────────────
const getValidation = async (req, res, next) => {
    try {
        const row = await db.DocumentValidation.findByPk(req.params.id);
        if (!row) return next(new AppError('NOT_FOUND', 'Validation not found', 404));
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId && row.tenant_id !== tenantId) {
                return next(new AppError('NOT_FOUND', 'Validation not found', 404));
            }
        }
        return sendSuccess(req, res, row);
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    validatePayload,
    validateDocument,
    listValidations,
    getValidation,
};
