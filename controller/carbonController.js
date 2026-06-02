'use strict';
/**
 * Carbon Footprint (Logistics #6, P2): estimate CO2e per shipment, purchase a voluntary offset, and
 * roll up an ESG report. Estimation via providers/carbon.js; offset is simulated.
 */
const crypto = require('crypto');
const db = require('../models');
const carbon = require('../providers/carbon');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

const genId = () => `CF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const num = (x) => (x == null ? 0 : Number(x));

// ── Tenant helpers ────────────────────────────────────────────────────────────
function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || [];
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}

function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}

async function fetchCarbonOwned(id, req, next) {
    const r = await db.CarbonFootprint.findByPk(id);
    if (!r) { next(new AppError('NOT_FOUND', 'Carbon footprint not found', 404)); return null; }
    if (isAdmin(req)) return r;
    const tenantId = callerTenantId(req);
    if (tenantId && r.tenant_id && r.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Carbon footprint not found', 404)); return null;
    }
    return r;
}

function toApi(r) {
    return {
        id: r.id, shipmentId: r.shipment_id, orderId: r.order_id, mode: r.mode,
        distanceKm: num(r.distance_km), weightKg: num(r.weight_kg), weightTonnes: num(r.weight_tonnes),
        emissionFactor: num(r.emission_factor), co2Kg: num(r.co2_kg), co2Tonnes: num(r.co2_tonnes),
        offsetCostUsd: num(r.offset_cost_usd), offsetStatus: r.offset_status,
        offsetProvider: r.offset_provider, offsetReference: r.offset_reference, offsetPurchasedAt: r.offset_purchased_at,
        methodology: r.methodology, createdAt: r.created_at, updatedAt: r.updated_at,
    };
}

// GET /carbon_footprints/estimate — ad-hoc, no persistence.
const estimate = async (req, res, next) => {
    try {
        const e = carbon.computeEmissions({ mode: req.query.mode, weightKg: req.query.weight || req.query.weightKg, distanceKm: req.query.distance || req.query.distanceKm });
        return sendSuccess(req, res, e);
    } catch (err) { return next(err); }
};

// GET /carbon_footprints/report — ESG roll-up across recorded footprints.
const report = async (req, res, next) => {
    try {
        const rows = await db.CarbonFootprint.findAll({ limit: 1000 });
        const totalCo2 = rows.reduce((a, r) => a + num(r.co2_tonnes), 0);
        const offsetCo2 = rows.filter((r) => r.offset_status === 'purchased').reduce((a, r) => a + num(r.co2_tonnes), 0);
        const byMode = {};
        for (const r of rows) {
            const m = r.mode || 'unknown';
            byMode[m] = byMode[m] || { shipments: 0, co2Tonnes: 0 };
            byMode[m].shipments += 1;
            byMode[m].co2Tonnes = Math.round((byMode[m].co2Tonnes + num(r.co2_tonnes)) * 1000) / 1000;
        }
        return sendSuccess(req, res, {
            shipmentsAssessed: rows.length,
            totalCo2Tonnes: Math.round(totalCo2 * 1000) / 1000,
            offsetCo2Tonnes: Math.round(offsetCo2 * 1000) / 1000,
            offsetRatePct: totalCo2 ? Math.round((offsetCo2 / totalCo2) * 1000) / 10 : 0,
            outstandingCo2Tonnes: Math.round((totalCo2 - offsetCo2) * 1000) / 1000,
            byMode,
            generatedAt: new Date().toISOString(),
        });
    } catch (err) { return next(err); }
};

const list = async (req, res, next) => {
    try {
        const where = {};
        const sid = req.query.shipmentId || req.query.shipment_id;
        if (sid) where.shipment_id = sid;
        if (req.query.offsetStatus) where.offset_status = req.query.offsetStatus;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const rows = await db.CarbonFootprint.findAll({ where, order: [['created_at', 'DESC']], limit: 500 });
        return sendSuccess(req, res, rows.map(toApi));
    } catch (err) { return next(err); }
};

const get = async (req, res, next) => {
    try {
        const r = await fetchCarbonOwned(req.params.id, req, next);
        if (!r) return undefined;
        return sendSuccess(req, res, toApi(r));
    } catch (err) { return next(err); }
};

// POST /carbon_footprints — compute + persist for a shipment leg.
const create = async (req, res, next) => {
    try {
        const b = req.body || {};
        const e = carbon.computeEmissions({ mode: b.mode, weightKg: b.weightKg ?? b.weight_kg, distanceKm: b.distanceKm ?? b.distance_km });
        const tenantId = callerTenantId(req);
        const row = await db.CarbonFootprint.create({
            id: b.id || genId(),
            shipment_id: b.shipmentId ?? b.shipment_id,
            order_id: b.orderId ?? b.order_id,
            mode: e.mode,
            distance_km: e.distanceKm,
            weight_kg: e.weightKg,
            weight_tonnes: e.weightTonnes,
            emission_factor: e.emissionFactor,
            co2_kg: e.co2Kg,
            co2_tonnes: e.co2Tonnes,
            offset_cost_usd: e.offsetCostUsd,
            offset_status: 'none',
            methodology: e.methodology,
            ...(tenantId ? { tenant_id: tenantId } : {}),
        });
        return sendSuccess(req, res, toApi(row), 201);
    } catch (err) { return next(err); }
};

// POST /carbon_footprints/:id/offset — purchase the offset (simulated).
const offset = async (req, res, next) => {
    try {
        const r = await fetchCarbonOwned(req.params.id, req, next);
        if (!r) return undefined;
        if (r.offset_status === 'purchased') return sendSuccess(req, res, toApi(r));
        const provider = (req.body && req.body.provider) || 'Gold Standard';
        await r.update({
            offset_status: 'purchased',
            offset_provider: provider,
            offset_reference: `OFFSET-${crypto.randomInt(100000, 999999)}`,
            offset_purchased_at: new Date(),
        });
        return sendSuccess(req, res, toApi(r));
    } catch (err) { return next(err); }
};

module.exports = { estimate, report, list, get, create, offset };
