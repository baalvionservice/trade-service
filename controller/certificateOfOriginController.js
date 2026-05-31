'use strict';
/**
 * Certificate of Origin (Logistics #5). Lifecycle: draft → issued (exporter e-stamp) → submitted (to a
 * chamber of commerce) → certified (chamber e-stamp) | rejected. Preferential CoOs carry a trade
 * agreement + origin criterion. Uses the e-sign provider seam for both stamps. Typed + persisted.
 */
const crypto = require('crypto');
const db = require('../models');
const providers = require('../providers');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const VALID = {
    draft: ['issued'],
    issued: ['submitted'],
    submitted: ['certified', 'rejected'],
    certified: [],
    rejected: ['submitted'],
};

function assertTransition(coo, to) {
    if (!(VALID[coo.status] || []).includes(to)) {
        throw new AppError('INVALID_TRANSITION', `cannot ${to} a certificate in '${coo.status}' state`, 409);
    }
}

const genId = () => `COO-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const genCertNumber = (country) => {
    const c = String(country || 'XX').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'XX';
    return `COO-${c}-${crypto.randomInt(1000000, 9999999)}`;
};

const findOr404 = async (req, next) => {
    const coo = await db.CertificateOfOrigin.findByPk(req.params.id);
    if (!coo) { next(new AppError('NOT_FOUND', 'Certificate of origin not found', 404)); return null; }
    return coo;
};

// ── CRUD ─────────────────────────────────────────────────────────────────────
const list = async (req, res, next) => {
    try {
        const { shipment_id, shipmentId, order_id, status, page = 1, limit = 20 } = req.query;
        const where = {};
        const sid = shipment_id || shipmentId;
        if (sid) where.shipment_id = sid;
        if (order_id) where.order_id = order_id;
        if (status) where.status = status;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.CertificateOfOrigin.findAndCountAll({ where, limit: Number(limit), offset, order: [['created_at', 'DESC']] });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) { return next(err); }
};

const get = async (req, res, next) => {
    try {
        const coo = await db.CertificateOfOrigin.findByPk(req.params.id);
        if (!coo) return next(new AppError('NOT_FOUND', 'Certificate of origin not found', 404));
        return sendSuccess(req, res, coo);
    } catch (err) { return next(err); }
};

const create = async (req, res, next) => {
    try {
        const b = req.body || {};
        // Preferential certificates must name the agreement they claim under.
        if (b.coo_type === 'preferential' && !b.agreement) {
            return next(new AppError('BAD_REQUEST', 'preferential certificate requires an agreement', 400));
        }
        const coo = await db.CertificateOfOrigin.create({ ...b, id: b.id || genId(), status: 'draft' });
        return sendSuccess(req, res, coo, 201);
    } catch (err) { return next(err); }
};

// ── lifecycle ────────────────────────────────────────────────────────────────
const issue = async (req, res, next) => {
    try {
        const coo = await findOr404(req, next); if (!coo) return undefined;
        assertTransition(coo, 'issued');
        if (!coo.origin_country || !(coo.goods && coo.goods.length)) {
            return next(new AppError('BAD_REQUEST', 'origin_country and goods are required to issue', 400));
        }
        const exporterName = (coo.exporter && (coo.exporter.name || coo.exporter.org)) || 'EXPORTER';
        const stamp = providers.esign.sign({ documentId: coo.id, party: exporterName, role: 'exporter' });
        await coo.update({
            status: 'issued',
            certificate_number: coo.certificate_number || genCertNumber(coo.origin_country),
            e_stamp: stamp,
            issued_at: new Date(),
        });
        return sendSuccess(req, res, coo);
    } catch (err) { return next(err); }
};

const submit = async (req, res, next) => {
    try {
        const coo = await findOr404(req, next); if (!coo) return undefined;
        assertTransition(coo, 'submitted');
        const chamber = (req.body && req.body.chamber) || coo.chamber || 'Chamber of Commerce';
        await coo.update({ status: 'submitted', chamber });
        return sendSuccess(req, res, coo);
    } catch (err) { return next(err); }
};

const certify = async (req, res, next) => {
    try {
        const coo = await findOr404(req, next); if (!coo) return undefined;
        assertTransition(coo, 'certified');
        const chamber = (req.body && req.body.chamber) || coo.chamber || 'Chamber of Commerce';
        const stamp = providers.esign.sign({ documentId: coo.id, party: chamber, role: 'chamber' });
        await coo.update({ status: 'certified', chamber, certifier_stamp: stamp, certified_at: new Date() });
        return sendSuccess(req, res, coo);
    } catch (err) { return next(err); }
};

const reject = async (req, res, next) => {
    try {
        const coo = await findOr404(req, next); if (!coo) return undefined;
        assertTransition(coo, 'rejected');
        await coo.update({ status: 'rejected', metadata: { ...(coo.metadata || {}), rejectReason: (req.body && req.body.reason) || null } });
        return sendSuccess(req, res, coo);
    } catch (err) { return next(err); }
};

// GET /:id/document — printable certificate of origin.
const document = async (req, res, next) => {
    try {
        const coo = await db.CertificateOfOrigin.findByPk(req.params.id);
        if (!coo) return next(new AppError('NOT_FOUND', 'Certificate of origin not found', 404));
        return sendSuccess(req, res, {
            form: coo.coo_type === 'preferential' ? `Preferential Certificate of Origin (${coo.agreement || 'FTA'})` : 'Non-Preferential Certificate of Origin',
            certificateNumber: coo.certificate_number,
            status: coo.status,
            exporter: coo.exporter,
            consignee: coo.consignee,
            producer: coo.producer,
            countryOfOrigin: coo.origin_country,
            countryOfDestination: coo.destination_country,
            originCriterion: coo.origin_criterion,
            transport: coo.transport_details,
            goods: coo.goods,
            agreement: coo.agreement,
            exporterDeclaration: coo.e_stamp,
            chamberCertification: coo.certifier_stamp,
            issuedAt: coo.issued_at,
            certifiedAt: coo.certified_at,
            issuingChamber: coo.chamber,
        });
    } catch (err) { return next(err); }
};

module.exports = { list, get, create, issue, submit, certify, reject, document };
