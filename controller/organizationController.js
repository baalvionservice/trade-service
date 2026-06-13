'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

// Resolve an org by integer PK or by external code ('COMP-101').
const resolveOrg = (idOrCode) =>
    (/^\d+$/.test(String(idOrCode))
        ? db.Organization.findByPk(idOrCode)
        : db.Organization.findOne({ where: { code: String(idOrCode) } }));

// Profile fields a non-platform admin may set. Identity (id/tenant_id/code) and compliance
// fields (kyc_status/risk_score/status) are deliberately excluded — they are assigned
// server-side or via the platform-only KYC endpoint, never via client-supplied body.
const ORG_CREATABLE_FIELDS = ['tenant_id', 'code', 'name', 'type', 'country', 'registration_number', 'contact_email'];
const ORG_UPDATABLE_FIELDS = ['name', 'type', 'country', 'registration_number', 'contact_email'];

// Returns a NEW object containing only the allowlisted keys present on the source.
const pick = (obj, fields) =>
    fields.reduce((acc, f) => (obj && obj[f] !== undefined ? { ...acc, [f]: obj[f] } : acc), {});

const isPlatformAdmin = (req) => req.auth && req.auth.role === 'super_admin';

// True when the caller's tenant owns this org. Platform super_admin owns all.
const ownsOrg = (req, org) =>
    isPlatformAdmin(req) || String(org.tenant_id) === String(req.auth && req.auth.tenantId);

const listOrgs = async (req, res, next) => {
    try {
        const { type, country, status, search, page = 1, limit = 20 } = req.query;
        const where = {};
        if (type) where.type = type;
        if (country) where.country = country;
        if (status) where.status = status;
        if (search) where.name = { [Op.iLike]: `%${search}%` };
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Organization.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getOrg = async (req, res, next) => {
    try {
        const org = await resolveOrg(req.params.id);
        if (!org) return next(new AppError('NOT_FOUND', 'Organization not found', 404));
        return sendSuccess(req, res, org);
    } catch (err) {
        return next(err);
    }
};

const createOrg = async (req, res, next) => {
    try {
        const data = pick(req.body, ORG_CREATABLE_FIELDS);
        // Non-platform admins may only create orgs within their own tenant; never trust a
        // client-supplied tenant_id from them.
        if (!isPlatformAdmin(req)) data.tenant_id = req.auth.tenantId;
        const org = await db.Organization.create(data);
        return sendSuccess(req, res, org, 201);
    } catch (err) {
        return next(err);
    }
};

const updateOrg = async (req, res, next) => {
    try {
        const org = await resolveOrg(req.params.id);
        if (!org) return next(new AppError('NOT_FOUND', 'Organization not found', 404));
        if (!ownsOrg(req, org)) {
            return next(new AppError('FORBIDDEN', 'Organization belongs to another tenant', 403));
        }
        await org.update(pick(req.body, ORG_UPDATABLE_FIELDS));
        return sendSuccess(req, res, org);
    } catch (err) {
        return next(err);
    }
};

const deleteOrg = async (req, res, next) => {
    try {
        const org = await resolveOrg(req.params.id);
        if (!org) return next(new AppError('NOT_FOUND', 'Organization not found', 404));
        await org.destroy();
        return sendSuccess(req, res, { deleted: true });
    } catch (err) {
        return next(err);
    }
};

const updateKyc = async (req, res, next) => {
    try {
        const org = await resolveOrg(req.params.id);
        if (!org) return next(new AppError('NOT_FOUND', 'Organization not found', 404));
        const { kyc_status, risk_score } = req.body;
        await org.update({ kyc_status, risk_score });
        return sendSuccess(req, res, org);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listOrgs, getOrg, createOrg, updateOrg, deleteOrg, updateKyc };
