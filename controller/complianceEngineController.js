'use strict';
// Compliance & Sanctions Engine — HTTP surface (War Room 4, Prompt 8).
// Thin controller: tenant ownership (defence in depth over RLS) + delegation to
// the engine. Two surfaces:
//   • screening — ad-hoc (POST /screen) + operation-scoped (persisted) + history.
//   • lists     — the tenant blacklist/whitelist CRUD.
const db = require('../models');
const engine = require('../service/compliance/complianceEngine');
const compliance = require('../service/compliance');
const norm = require('../service/compliance/normalize');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const { schema, dataset } = compliance;

// Allowlists for query-filter validation — an out-of-allowlist filter value is
// ignored rather than passed raw into the Sequelize `where` (defence against
// operator-object injection + nonsensical queries).
const DECISION_VALUES = new Set(Object.values(schema.DECISION));
const SCREENING_SEVERITY_VALUES = new Set(Object.values(schema.SEVERITY)); // none..critical
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cross-tenant bypass roles — kept in lockstep with the platform-admin set used by
// readinessController / workflowController. A `compliance` role is deliberately NOT
// a cross-tenant bypass: compliance officers are tenant-scoped like everyone else,
// so a tenant's screening data + blacklist/whitelist stay isolated to that tenant.
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

/** Load a trade operation and enforce tenant ownership; 404 on cross-tenant. */
async function fetchOperationOwned(id, req, next) {
    const operation = await db.TradeOperation.findByPk(id);
    if (!operation) { next(new AppError('NOT_FOUND', 'Trade operation not found', 404)); return null; }
    if (isAdmin(req)) return operation;
    const tenantId = callerTenantId(req);
    if (tenantId && operation.tenant_id && operation.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Trade operation not found', 404)); return null;
    }
    return operation;
}

// ── GET /v1/compliance_screening/definition ──────────────────────────────────
// Public descriptor: the checks, severities, decisions + reference-data summary.
const getDefinition = (req, res) => sendSuccess(req, res, {
    engine_version: compliance.report.ENGINE_VERSION,
    decisions: schema.DECISION,
    severities: schema.SEVERITY,
    severity_points: compliance.severity.SEVERITY_POINTS,
    checks: schema.ALL_CHECKS,
    hook_statuses: schema.HOOK_STATUS,
    triggers: ['manual', 'api', 'workflow_transition', 'order', 'placement', 'scheduler', 'backfill'],
    reference_data: {
        sanctioned_countries: dataset.sanctionedCountries().length,
        named_parties: dataset.namedParties().length,
        controlled_goods: dataset.controlledGoods().length,
        trade_bans: dataset.tradeBans().length,
        note: 'Illustrative dataset — replace with a licensed sanctions/export-control feed for production.',
    },
});

// ── POST /v1/compliance_screening/screen ─────────────────────────────────────
// Ad-hoc, stateless screening of an arbitrary subject (no persistence).
const screenAdhoc = async (req, res, next) => {
    try {
        const body = req.body || {};
        const tenantId = callerTenantId(req);
        const report = await engine.screen(body, { tenantId, runHooks: body.runHooks !== false });
        return sendSuccess(req, res, report);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/compliance_screening/operations/:operationId ──────────────────────
// The live, cached compliance screening for an operation (seeds one on first read).
const getOperationLatest = async (req, res, next) => {
    try {
        const operation = await fetchOperationOwned(req.params.operationId, req, next);
        if (!operation) return undefined;
        const view = await engine.getLatest(operation);
        return sendSuccess(req, res, view);
    } catch (err) {
        return next(err);
    }
};

// ── POST /v1/compliance_screening/operations/:operationId/screen ──────────────
// Force a fresh screening + persisted snapshot + cache refresh.
const screenOperation = async (req, res, next) => {
    try {
        const operation = await fetchOperationOwned(req.params.operationId, req, next);
        if (!operation) return undefined;
        const body = req.body || {};
        const { view } = await engine.screenOperation(operation.id, {
            overrides: body.overrides || {},
            trigger: 'api',
            reason: body.reason || null,
            actor: actorOf(req),
            tenantId: operation.tenant_id,
            runHooks: body.runHooks !== false,
        });
        return sendSuccess(req, res, view, 201);
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/compliance_screening/operations/:operationId/history ──────────────
const getOperationHistory = async (req, res, next) => {
    try {
        const operation = await fetchOperationOwned(req.params.operationId, req, next);
        if (!operation) return undefined;
        const { page = 1, limit = 20 } = req.query;
        const result = await engine.listHistory(operation.id, { page, limit, tenantId: operation.tenant_id });
        return sendPaginated(req, res, {
            items: result.items, total: result.total, page: result.page, limit: result.limit, pages: result.pages,
        });
    } catch (err) {
        return next(err);
    }
};

// ── GET /v1/compliance_screening ──────────────────────────────────────────────
// List persisted screenings across the tenant (filter by decision / severity / op).
const listScreenings = async (req, res, next) => {
    try {
        const { decision, severity, trade_operation_id, blocking, page = 1, limit = 20 } = req.query;
        const where = {};
        if (typeof decision === 'string' && DECISION_VALUES.has(decision)) where.decision = decision;
        if (typeof severity === 'string' && SCREENING_SEVERITY_VALUES.has(severity)) where.severity = severity;
        if (typeof trade_operation_id === 'string' && UUID_RE.test(trade_operation_id)) where.trade_operation_id = trade_operation_id;
        if (blocking !== undefined) where.blocking = blocking === 'true' || blocking === true;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const p = Math.max(1, Number(page) || 1);
        const l = Math.min(100, Math.max(1, Number(limit) || 20));
        const { count, rows } = await db.ComplianceScreening.findAndCountAll({
            where, limit: l, offset: (p - 1) * l, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: p, limit: l });
    } catch (err) {
        return next(err);
    }
};

// ── Tenant blacklist / whitelist CRUD ─────────────────────────────────────────

const LIST_TYPES = new Set(['blacklist', 'whitelist']);
const SUBJECT_TYPES = new Set(['party', 'country', 'good', 'hs_code', 'entity']);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const MAX_VALUE_LEN = 512; // upper bound on a normalized list-entry value

/** Normalize a list-entry value by its subject type (countries → alpha-2, etc.). */
function normalizeEntryValue(subjectType, value) {
    if (subjectType === 'country') return norm.normalizeCountry(value);
    if (subjectType === 'hs_code') return norm.digitsOnly(value);
    return String(value).trim();
}

/**
 * Validate an optional expires_at input. Returns { ok, value } or { ok:false, error }.
 * Absent → null (never expires). Present → must be a parseable date in the FUTURE
 * (a past/invalid date would silently make the entry inert, a confusing footgun).
 */
function parseExpiry(input) {
    if (input === undefined || input === null || input === '') return { ok: true, value: null };
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'expires_at is not a valid date' };
    if (d.getTime() <= Date.now()) return { ok: false, error: 'expires_at must be in the future' };
    return { ok: true, value: d };
}

// GET /v1/compliance_screening/lists
const listEntries = async (req, res, next) => {
    try {
        const { list_type, subject_type, page = 1, limit = 50 } = req.query;
        const where = {};
        if (typeof list_type === 'string' && LIST_TYPES.has(list_type)) where.list_type = list_type;
        if (typeof subject_type === 'string' && SUBJECT_TYPES.has(subject_type)) where.subject_type = subject_type;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const p = Math.max(1, Number(page) || 1);
        const l = Math.min(200, Math.max(1, Number(limit) || 50));
        const { count, rows } = await db.ComplianceListEntry.findAndCountAll({
            where, limit: l, offset: (p - 1) * l, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: p, limit: l });
    } catch (err) {
        return next(err);
    }
};

// POST /v1/compliance_screening/lists
const createEntry = async (req, res, next) => {
    try {
        const body = req.body || {};
        const listType = String(body.list_type || '').toLowerCase();
        const subjectType = String(body.subject_type || '').toLowerCase();
        if (!LIST_TYPES.has(listType)) return next(new AppError('VALIDATION', `list_type must be one of: ${[...LIST_TYPES].join(', ')}`, 422));
        if (!SUBJECT_TYPES.has(subjectType)) return next(new AppError('VALIDATION', `subject_type must be one of: ${[...SUBJECT_TYPES].join(', ')}`, 422));
        if (norm.isBlank(body.value)) return next(new AppError('VALIDATION', 'value is required', 422));
        if (String(body.value).length > MAX_VALUE_LEN) return next(new AppError('VALIDATION', `value exceeds ${MAX_VALUE_LEN} characters`, 422));
        const value = normalizeEntryValue(subjectType, body.value);
        if (norm.isBlank(value)) return next(new AppError('VALIDATION', 'value did not normalize to a usable token', 422));
        if (String(value).length > MAX_VALUE_LEN) return next(new AppError('VALIDATION', `value exceeds ${MAX_VALUE_LEN} characters`, 422));

        const expiry = parseExpiry(body.expires_at);
        if (!expiry.ok) return next(new AppError('VALIDATION', expiry.error, 422));

        const severity = SEVERITIES.has(body.severity) ? body.severity : 'high';
        const tenantId = callerTenantId(req);

        const entry = await db.ComplianceListEntry.create({
            tenant_id: tenantId || undefined, // tenant hook stamps when context present
            list_type: listType,
            subject_type: subjectType,
            value,
            reason: body.reason || null,
            severity,
            active: body.active !== false,
            expires_at: expiry.value,
            created_by: actorOf(req),
        });
        return sendSuccess(req, res, entry, 201);
    } catch (err) {
        if (err && err.name === 'SequelizeUniqueConstraintError') {
            return next(new AppError('CONFLICT', 'A list entry with this (list_type, subject_type, value) already exists', 409));
        }
        return next(err);
    }
};

/** Load a tenant-owned list entry; 404 on cross-tenant. */
async function fetchEntryOwned(id, req, next) {
    const entry = await db.ComplianceListEntry.findByPk(id);
    if (!entry) { next(new AppError('NOT_FOUND', 'List entry not found', 404)); return null; }
    if (!isAdmin(req)) {
        const tenantId = callerTenantId(req);
        if (tenantId && entry.tenant_id && entry.tenant_id !== tenantId) {
            next(new AppError('NOT_FOUND', 'List entry not found', 404)); return null;
        }
    }
    return entry;
}

// PATCH /v1/compliance_screening/lists/:id
const updateEntry = async (req, res, next) => {
    try {
        const entry = await fetchEntryOwned(req.params.id, req, next);
        if (!entry) return undefined;
        const body = req.body || {};
        const patch = {};
        if (body.reason !== undefined) patch.reason = body.reason;
        if (body.severity !== undefined && SEVERITIES.has(body.severity)) patch.severity = body.severity;
        if (body.active !== undefined) patch.active = !!body.active;
        if (body.expires_at !== undefined) {
            const expiry = parseExpiry(body.expires_at);
            if (!expiry.ok) return next(new AppError('VALIDATION', expiry.error, 422));
            patch.expires_at = expiry.value;
        }
        await entry.update(patch);
        return sendSuccess(req, res, entry);
    } catch (err) {
        return next(err);
    }
};

// DELETE /v1/compliance_screening/lists/:id
const deleteEntry = async (req, res, next) => {
    try {
        const entry = await fetchEntryOwned(req.params.id, req, next);
        if (!entry) return undefined;
        await entry.destroy();
        return sendSuccess(req, res, { id: entry.id, deleted: true });
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    getDefinition,
    screenAdhoc,
    getOperationLatest,
    screenOperation,
    getOperationHistory,
    listScreenings,
    listEntries,
    createEntry,
    updateEntry,
    deleteEntry,
};
