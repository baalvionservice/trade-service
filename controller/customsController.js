'use strict';
/**
 * Customs Filing (Logistics #4). Accepts + returns camelCase CustomsEntry (the GTI customs-service has
 * no mapper) over a typed snake_case model. On create it auto-classifies each line item's HS code and
 * computes duty + import tax, assigns the destination country's declaration template, and supports the
 * clearance workflow. Utility endpoints: /classify, /tariff, /:id/declaration (5-country forms).
 */
const crypto = require('crypto');
const db = require('../models');
const hs = require('../providers/hs');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

const genId = () => `CE-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function toApi(r) {
    const li = Array.isArray(r.line_items) ? r.line_items : [];
    return {
        id: r.id,
        shipmentId: r.shipment_id,
        orderId: r.order_id,
        originCountry: r.origin_country,
        destinationCountry: r.destination_country,
        country: r.destination_country,
        entryType: r.entry_type,
        status: r.status,
        hsCode: li[0] && (li[0].hsCode || li[0].hs_code),
        incoterm: r.incoterm,
        currency: r.currency,
        declaredValue: Number(r.customs_value),
        customsValue: Number(r.customs_value),
        lineItems: li,
        totalDuty: Number(r.total_duty),
        totalTax: Number(r.total_tax),
        totalPayable: Number(r.total_payable),
        duties: { duty: Number(r.total_duty), tax: Number(r.total_tax), total: Number(r.total_payable) },
        template: r.template,
        filingReference: r.filing_reference,
        authorizedBy: r.authorized_by,
        inspectionNotes: r.inspection_notes,
        submittedAt: r.submitted_at,
        clearedAt: r.cleared_at,
        documents: [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function fromApi(b = {}) {
    const v = {
        shipment_id: b.shipmentId ?? b.shipment_id,
        order_id: b.orderId ?? b.order_id,
        origin_country: b.originCountry ?? b.origin_country,
        destination_country: b.destinationCountry ?? b.destination_country ?? b.country,
        entry_type: b.entryType ?? b.entry_type ?? 'import',
        declarant: b.declarant,
        importer: b.importer,
        exporter: b.exporter,
        incoterm: b.incoterm,
        currency: b.currency ?? 'USD',
        customs_value: b.customsValue ?? b.declaredValue ?? b.customs_value,
        line_items: b.lineItems ?? b.line_items,
        status: b.status,
        metadata: b.metadata,
    };
    Object.keys(v).forEach((k) => v[k] === undefined && delete v[k]);
    return v;
}

// Classify HS + compute duty/tax for every line, returning enriched lines + totals.
async function priceLines(rawLines, country, fallback) {
    let lines = Array.isArray(rawLines) ? rawLines.slice() : [];
    if (!lines.length && fallback && (fallback.hsCode || fallback.value)) {
        lines = [{ description: fallback.description || 'Declared goods', hsCode: fallback.hsCode, quantity: 1, unitValue: Number(fallback.value) || 0 }];
    }
    let totalValue = 0; let totalDuty = 0; let totalTax = 0;
    const enriched = [];
    for (const li of lines) {
        let hsCode = li.hsCode || li.hs_code;
        let hsDescription = li.hsDescription;
        let classifiedBy;
        if (!hsCode) {
            const c = await hs.classify(li.description);
            hsCode = c.hsCode; hsDescription = c.hsDescription; classifiedBy = c.source;
        }
        const qty = Number(li.quantity) || 1;
        const unit = Number(li.unitValue ?? li.unit_value ?? 0);
        const lineValue = Number(li.lineValue) || qty * unit || Number(li.value) || 0;
        const d = hs.computeDuty(hsCode, country, lineValue);
        enriched.push({
            ...li, hsCode, hsDescription, classifiedBy, quantity: qty, unitValue: unit, lineValue,
            dutyRate: d.dutyRate, dutyAmount: d.dutyAmount, taxRate: d.taxRate, taxAmount: d.taxAmount,
        });
        totalValue += lineValue; totalDuty += d.dutyAmount; totalTax += d.taxAmount;
    }
    return { lines: enriched, totalValue: round2(totalValue), totalDuty: round2(totalDuty), totalTax: round2(totalTax) };
}

// ── CRUD + workflow ──────────────────────────────────────────────────────────
const list = async (req, res, next) => {
    try {
        const where = {};
        const shipmentId = req.query.shipmentId || req.query.shipment_id;
        if (shipmentId) where.shipment_id = shipmentId;
        if (req.query.status) where.status = req.query.status;
        const country = req.query.country || req.query.destinationCountry;
        if (country) where.destination_country = country;
        const rows = await db.CustomsEntry.findAll({ where, order: [['created_at', 'DESC']], limit: 200 });
        return sendSuccess(req, res, rows.map(toApi));
    } catch (err) { return next(err); }
};

const get = async (req, res, next) => {
    try {
        const row = await db.CustomsEntry.findByPk(req.params.id);
        if (!row) return next(new AppError('NOT_FOUND', 'Customs entry not found', 404));
        return sendSuccess(req, res, toApi(row));
    } catch (err) { return next(err); }
};

const create = async (req, res, next) => {
    try {
        const b = req.body || {};
        const v = fromApi(b);
        const country = v.destination_country;
        const priced = await priceLines(v.line_items, country, { hsCode: b.hsCode, value: v.customs_value, description: b.description || b.goodsDescription });
        v.line_items = priced.lines;
        if (!v.customs_value || Number(v.customs_value) === 0) v.customs_value = priced.totalValue;
        v.total_duty = priced.totalDuty;
        v.total_tax = priced.totalTax;
        v.total_payable = round2(priced.totalDuty + priced.totalTax);
        v.template = hs.templateFor(country);
        v.id = b.id || genId();
        if (!v.status) v.status = 'draft';
        const row = await db.CustomsEntry.create(v);
        return sendSuccess(req, res, toApi(row), 201);
    } catch (err) { return next(err); }
};

// PATCH /:id — clearance-status transitions (frontend updateClearanceStatus) + field edits.
const patch = async (req, res, next) => {
    try {
        const row = await db.CustomsEntry.findByPk(req.params.id);
        if (!row) return next(new AppError('NOT_FOUND', 'Customs entry not found', 404));
        const b = req.body || {};
        const updates = {};
        if (b.status !== undefined) updates.status = b.status;
        if (b.authorizedBy !== undefined) updates.authorized_by = b.authorizedBy;
        if (b.inspectionNotes !== undefined) updates.inspection_notes = b.inspectionNotes;
        if (b.template !== undefined) updates.template = b.template;
        if (b.filingReference !== undefined) updates.filing_reference = b.filingReference;
        const st = String(b.status || '').toUpperCase();
        if (st === 'CLEARED' && !row.cleared_at) updates.cleared_at = new Date();
        if ((st === 'SUBMITTED' || st === 'PENDING') && !row.submitted_at) {
            updates.submitted_at = new Date();
            if (!row.template) updates.template = hs.templateFor(row.destination_country);
            if (!row.filing_reference) updates.filing_reference = `${hs.templateFor(row.destination_country)}-${crypto.randomInt(100000, 999999)}`;
        }
        await row.update(updates);
        return sendSuccess(req, res, toApi(row));
    } catch (err) { return next(err); }
};

const action = (targetStatus, stamp) => async (req, res, next) => {
    try {
        const row = await db.CustomsEntry.findByPk(req.params.id);
        if (!row) return next(new AppError('NOT_FOUND', 'Customs entry not found', 404));
        const updates = { status: targetStatus };
        if (targetStatus === 'submitted') {
            updates.submitted_at = new Date();
            updates.template = row.template || hs.templateFor(row.destination_country);
            updates.filing_reference = row.filing_reference || `${updates.template}-${crypto.randomInt(100000, 999999)}`;
        }
        if (targetStatus === 'cleared') updates.cleared_at = new Date();
        if (stamp && req.body) {
            if (req.body.authorizedBy) updates.authorized_by = req.body.authorizedBy;
            if (req.body.notes || req.body.inspectionNotes) updates.inspection_notes = req.body.notes || req.body.inspectionNotes;
        }
        await row.update(updates);
        return sendSuccess(req, res, toApi(row));
    } catch (err) { return next(err); }
};

// ── utilities ────────────────────────────────────────────────────────────────
const classify = async (req, res, next) => {
    try {
        const description = (req.body && (req.body.description || req.body.goodsDescription)) || req.query.description;
        if (!description) return next(new AppError('BAD_REQUEST', 'description is required', 400));
        const result = await hs.classify(description);
        return sendSuccess(req, res, result);
    } catch (err) { return next(err); }
};

const tariff = async (req, res, next) => {
    try {
        const { hsCode, country } = req.query;
        const value = req.query.value;
        if (!hsCode || !country) return next(new AppError('BAD_REQUEST', 'hsCode and country are required', 400));
        const d = hs.computeDuty(hsCode, country, value || 0);
        return sendSuccess(req, res, { hsCode, country, value: Number(value) || 0, ...d, template: hs.templateFor(country) });
    } catch (err) { return next(err); }
};

// GET /:id/declaration — render the destination country's declaration form from the entry.
const declaration = async (req, res, next) => {
    try {
        const row = await db.CustomsEntry.findByPk(req.params.id);
        if (!row) return next(new AppError('NOT_FOUND', 'Customs entry not found', 404));
        const e = toApi(row);
        const common = {
            entryId: e.id, reference: e.filingReference, shipmentId: e.shipmentId,
            importer: row.importer, exporter: row.exporter, incoterm: e.incoterm,
            originCountry: e.originCountry, destinationCountry: e.destinationCountry,
            currency: e.currency, customsValue: e.customsValue,
            duty: e.totalDuty, tax: e.totalTax, totalPayable: e.totalPayable,
            lines: e.lineItems.map((l) => ({ description: l.description, hsCode: l.hsCode, value: l.lineValue, duty: l.dutyAmount, tax: l.taxAmount })),
        };
        const FORMS = {
            US_CBP_7501: { form: 'CBP Form 7501 — Entry Summary', portOfEntry: e.destinationCountry, importerOfRecord: row.importer },
            EU_SAD: { form: 'Single Administrative Document (SAD)', box1Declaration: 'IM', box8Consignee: row.importer },
            IN_BOE: { form: 'Bill of Entry (India Customs)', iecCode: (row.importer && row.importer.iec) || null, assessableValue: e.customsValue },
            CN_DECL: { form: 'China Customs Import Declaration', consignee: row.importer, customsDistrict: 'TBD' },
            UK_C88: { form: 'Form C88 (UK SAD)', cdsDeclaration: true, consignee: row.importer },
            GENERIC_DECLARATION: { form: 'Customs Declaration' },
        };
        const tpl = FORMS[e.template] || FORMS.GENERIC_DECLARATION;
        return sendSuccess(req, res, { template: e.template, ...tpl, ...common });
    } catch (err) { return next(err); }
};

module.exports = {
    list, get, create, patch,
    submit: action('submitted', false),
    clear: action('cleared', true),
    hold: action('CUSTOMS_HOLD', true),
    classify, tariff, declaration,
};
