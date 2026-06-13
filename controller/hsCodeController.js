'use strict';
// HS Code Intelligence Engine — HTTP surface (Prompt 7).
// Thin controller: input validation + tenant ownership + delegation to the engine.
const db = require('../models');
const engine = require('../service/hscode/hsEngine');
const duty = require('../service/hscode/duty');
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
const toInt = (v, dflt) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
};
const toNum = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

// ── GET /v1/hs_codes/search?q=&country=&limit= ───────────────────────────────
// The search API: keyword search over the HS database. Stateless, no persistence.
const searchCodes = async (req, res, next) => {
    try {
        const q = req.query.q || req.query.query;
        if (!q || !String(q).trim()) return next(new AppError('QUERY_REQUIRED', 'Provide a `q` search term', 422));
        const limit = Math.min(Math.max(toInt(req.query.limit, 5), 1), 25);
        const suggestions = engine.search({ query: q, country: req.query.country || null, limit });
        return sendSuccess(req, res, { query: q, suggestions });
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/hs_codes/suggest ────────────────────────────────────────────────
// Stateless product → HS pipeline (search + AI + fallback → flags → duty). No DB.
const suggest = async (req, res, next) => {
    try {
        const {
            product, hs_code, destination_country, origin_country,
            customs_value, currency, limit, options = {},
        } = req.body || {};
        if ((!product || !String(product).trim()) && !hs_code) {
            return next(new AppError('PRODUCT_REQUIRED', 'Provide `product` text and/or an `hs_code`', 422));
        }
        const report = await engine.suggest({
            product: product || '',
            hsCode: hs_code || null,
            destinationCountry: destination_country || null,
            originCountry: origin_country || null,
            customsValue: toNum(customs_value),
            currency: currency || null,
            limit: Math.min(Math.max(toInt(limit, 5), 1), 25),
            options: typeof options === 'object' && options ? options : {},
        });
        return sendSuccess(req, res, { suggestion_report: report });
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/hs_codes/classify ───────────────────────────────────────────────
// Operation-bound: classify a product (optionally pulling context from a trade
// operation), persist the report, return it.
const classify = async (req, res, next) => {
    try {
        const {
            product, hs_code, product_ref, trade_operation_id,
            destination_country, origin_country, customs_value, currency, limit,
            options = {}, persist = true,
        } = req.body || {};
        if ((!product || !String(product).trim()) && !hs_code && !trade_operation_id) {
            return next(new AppError('PRODUCT_REQUIRED', 'Provide `product`, `hs_code`, or `trade_operation_id`', 422));
        }

        const tenantId = callerTenantId(req);
        const { report, record } = await engine.classifyProduct({
            tradeOperationId: trade_operation_id || null,
            productRef: product_ref || null,
            product: product || '',
            hsCode: hs_code || null,
            destinationCountry: destination_country || null,
            originCountry: origin_country || null,
            customsValue: toNum(customs_value),
            currency: currency || null,
            limit: Math.min(Math.max(toInt(limit, 5), 1), 25),
            options: typeof options === 'object' && options ? options : {},
            actor: actorOf(req),
            persist: persist !== false,
        });

        // Tenant ownership guard (defense in depth on top of RLS).
        if (record && !isAdmin(req) && tenantId && record.tenant_id && record.tenant_id !== tenantId) {
            return next(new AppError('FORBIDDEN', 'Classification belongs to another tenant', 403));
        }

        return sendSuccess(req, res, {
            suggestion_report: report,
            classification_id: record ? record.id : null,
        }, 201);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/hs_codes/classifications ─────────────────────────────────────────
const listClassifications = async (req, res, next) => {
    try {
        const {
            suggested_code, trade_operation_id, needs_review, page = 1, limit = 20,
        } = req.query;
        const where = {};
        if (suggested_code) where.suggested_code = String(suggested_code);
        if (trade_operation_id) where.trade_operation_id = trade_operation_id;
        if (needs_review !== undefined) where.needs_review = needs_review === 'true' || needs_review === true;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const lim = Math.min(Math.max(toInt(limit, 20), 1), 100);
        const offset = (Math.max(toInt(page, 1), 1) - 1) * lim;
        const { count, rows } = await db.HsClassification.findAndCountAll({
            where, limit: lim, offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, {
            items: rows, total: count, page: Math.max(toInt(page, 1), 1), limit: lim,
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/hs_codes/classifications/:id ─────────────────────────────────────
const getClassification = async (req, res, next) => {
    try {
        const row = await db.HsClassification.findByPk(req.params.id);
        if (!row) return next(new AppError('NOT_FOUND', 'Classification not found', 404));
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId && row.tenant_id !== tenantId) {
                return next(new AppError('NOT_FOUND', 'Classification not found', 404));
            }
        }
        return sendSuccess(req, res, row);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/hs_codes/duty ───────────────────────────────────────────────────
// Duty estimation hook: estimate landed duty + import tax for a code + country.
const estimateDuty = async (req, res, next) => {
    try {
        const {
            hs_code, country, origin_country, customs_value, currency,
        } = req.body || {};
        if (!hs_code) return next(new AppError('HS_CODE_REQUIRED', '`hs_code` is required', 422));
        if (!country) return next(new AppError('COUNTRY_REQUIRED', '`country` (destination) is required', 422));
        const estimate = duty.estimateDuty({
            hsCode: hs_code,
            country,
            originCountry: origin_country || null,
            customsValue: toNum(customs_value),
            currency: currency || null,
        });
        return sendSuccess(req, res, { duty_estimate: estimate });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/hs_codes/:code ───────────────────────────────────────────────────
// Lookup a specific HS code: national line, compliance flags, duty hook.
const lookup = async (req, res, next) => {
    try {
        const result = engine.lookup({
            hsCode: req.params.code,
            country: req.query.country || null,
            customsValue: toNum(req.query.customs_value),
            currency: req.query.currency || null,
            direction: req.query.direction || 'both',
        });
        return sendSuccess(req, res, result);
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    searchCodes,
    suggest,
    classify,
    listClassifications,
    getClassification,
    estimateDuty,
    lookup,
};
