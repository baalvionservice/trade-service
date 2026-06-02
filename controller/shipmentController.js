'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const providers = require('../providers');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const DWELL_HOURS = Number(process.env.SHIPMENT_DWELL_HOURS || 72);

function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || [];
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}

function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}

async function fetchShipmentOwned(id, req, next) {
    const shipment = await db.Shipment.findByPk(id);
    if (!shipment) { next(new AppError('NOT_FOUND', 'Shipment not found', 404)); return null; }
    if (isAdmin(req)) return shipment;
    const tenantId = callerTenantId(req);
    if (tenantId && shipment.tenant_id && shipment.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Shipment not found', 404)); return null;
    }
    return shipment;
}

const listShipments = async (req, res, next) => {
    try {
        const { status, order_id, carrier_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (order_id) where.order_id = order_id;
        if (carrier_id) where.carrier_id = carrier_id;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Shipment.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getShipment = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.id, req, next);
        if (!shipment) return undefined;
        return sendSuccess(req, res, shipment);
    } catch (err) {
        return next(err);
    }
};

const createShipment = async (req, res, next) => {
    try {
        const { tenant_id: _ignored, ...body } = req.body || {};
        const tenantId = callerTenantId(req);
        const shipment = await db.Shipment.create({ ...body, ...(tenantId ? { tenant_id: tenantId } : {}) });
        return sendSuccess(req, res, shipment, 201);
    } catch (err) {
        return next(err);
    }
};

const updateShipment = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.id, req, next);
        if (!shipment) return undefined;
        const { tenant_id: _ignored, ...updates } = req.body || {};
        await shipment.update(updates);
        return sendSuccess(req, res, shipment);
    } catch (err) {
        return next(err);
    }
};

const addMilestone = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.id, req, next);
        if (!shipment) return undefined;
        const milestone = { ...req.body, timestamp: req.body.timestamp || new Date().toISOString() };
        const milestones = [...(shipment.milestones || []), milestone];
        await shipment.update({ milestones });
        return sendSuccess(req, res, shipment, 201);
    } catch (err) {
        return next(err);
    }
};

const addException = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.id, req, next);
        if (!shipment) return undefined;
        const exception = { ...req.body, timestamp: req.body.timestamp || new Date().toISOString() };
        const exceptions = [...(shipment.exceptions || []), exception];
        await shipment.update({ exceptions });
        return sendSuccess(req, res, shipment, 201);
    } catch (err) {
        return next(err);
    }
};

const updateShipmentStatus = async (req, res, next) => {
    try {
        const shipment = await fetchShipmentOwned(req.params.id, req, next);
        if (!shipment) return undefined;
        const { status } = req.body;
        if (!status) return next(new AppError('BAD_REQUEST', 'status is required', 400));
        await shipment.update({ status });
        // Realtime push to the shipment + tenant rooms (best-effort).
        require('../realtime').publish(`shipment:${shipment.id}`, 'status', { id: shipment.id, status }).catch(() => {});
        return sendSuccess(req, res, shipment);
    } catch (err) {
        return next(err);
    }
};

// ── Shipment Tracking (Logistics #2): carrier-tracking provider + exception detection ──────────

// Rule-based exception detection over a shipment snapshot.
function detectExceptions(shipment) {
    const out = [];
    const now = Date.now();
    const status = String(shipment.status || '').toLowerCase();
    const terminal = ['delivered', 'cancelled'];
    const eta = shipment.estimated_arrival ? new Date(shipment.estimated_arrival).getTime() : null;

    if (status === 'customs_hold') {
        out.push({ code: 'CUSTOMS_HOLD', severity: 'high', message: 'Shipment held at customs — clearance required.' });
    }
    if (eta && now > eta && !terminal.includes(status)) {
        const daysLate = Math.max(1, Math.round((now - eta) / 86400000));
        out.push({ code: 'DELAY', severity: 'medium', message: `Past ETA by ${daysLate}d and not yet delivered.` });
    }
    const ms = Array.isArray(shipment.milestones) ? shipment.milestones : [];
    const last = ms[ms.length - 1];
    if (last && last.timestamp && !terminal.includes(status)) {
        const ageH = (now - new Date(last.timestamp).getTime()) / 3600000;
        if (ageH > DWELL_HOURS) {
            out.push({ code: 'DWELL', severity: 'medium', message: `No tracking update in ${Math.round(ageH)}h.` });
        }
    }
    return out;
}

// Apply a provider tracking view to a shipment: advance status/milestones forward-only (never
// regress, never override a manual off-path status), detect new exceptions, persist + fan out.
async function applyTracking(shipment, view) {
    const changes = { statusChanged: false, milestonesAdded: 0, newExceptions: [] };
    const { lifecycleIndex, LIFECYCLE } = providers.tracking;
    const curIdx = lifecycleIndex(shipment.status);
    const newIdx = lifecycleIndex(view.status);
    const updates = {};
    const milestones = Array.isArray(shipment.milestones) ? [...shipment.milestones] : [];

    if (curIdx >= 0 && newIdx > curIdx) {
        const have = new Set(milestones.map((m) => String(m.status || '').toLowerCase()));
        for (let i = curIdx + 1; i <= newIdx; i += 1) {
            const stage = LIFECYCLE[i];
            if (have.has(stage)) continue;
            const ev = (view.events || []).find((e) => e.status === stage);
            milestones.push({
                id: `MLS-${stage.toUpperCase()}`,
                status: stage.toUpperCase(),
                location: ev ? ev.location : (shipment.destination || 'In transit'),
                timestamp: ev ? ev.timestamp : new Date().toISOString(),
                source: 'carrier_tracking',
                isVerified: true,
                verifiedBy: 'CARRIER_TRACKING',
            });
            changes.milestonesAdded += 1;
        }
        updates.status = view.status;
        updates.milestones = milestones;
        changes.statusChanged = true;
        if (view.status === 'delivered' && !shipment.actual_arrival) updates.actual_arrival = new Date();
    }

    // Exception detection against the would-be new state; only add codes not already active.
    const candidate = { ...shipment.toJSON(), ...updates };
    const existing = Array.isArray(shipment.exceptions) ? shipment.exceptions : [];
    const activeCodes = new Set(existing.filter((e) => !e.resolved).map((e) => e.code));
    const fresh = detectExceptions(candidate)
        .filter((d) => !activeCodes.has(d.code))
        .map((d) => ({ ...d, detectedAt: new Date().toISOString(), resolved: false }));
    if (fresh.length) { updates.exceptions = [...existing, ...fresh]; changes.newExceptions = fresh; }

    if (Object.keys(updates).length) {
        await shipment.update(updates);
        const realtime = require('../realtime');
        if (changes.statusChanged) {
            realtime.publish(`shipment:${shipment.id}`, 'status', { id: shipment.id, status: shipment.status }).catch(() => {});
        }
        for (const ex of changes.newExceptions) {
            realtime.publish(`shipment:${shipment.id}`, 'exception', { id: shipment.id, ...ex }).catch(() => {});
            try {
                await db.Collection.create({
                    collection: 'alerts',
                    tenantId: shipment.tenant_id || 'T-DEMO',
                    data: {
                        status: 'active', category: 'LOGISTICS', severity: ex.severity, code: ex.code,
                        message: ex.message, shipmentId: shipment.id, createdAt: new Date().toISOString(),
                    },
                });
            } catch { /* best-effort alert for the /alerts feed */ }
        }
    }
    return { shipment, changes };
}

// GET /shipments/:id/track — read-only current tracking view (public, no authMiddleware on this route).
const trackShipment = async (req, res, next) => {
    try {
        const shipment = await db.Shipment.findByPk(req.params.id);
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        const view = await providers.tracking.track(shipment.toJSON());
        return sendSuccess(req, res, {
            shipmentId: shipment.id,
            status: shipment.status,
            trackingNumber: shipment.tracking_number,
            tracking: view,
            milestones: shipment.milestones || [],
            exceptions: shipment.exceptions || [],
        });
    } catch (err) { return next(err); }
};

// POST /shipments/:id/track/refresh — pull provider, advance the shipment, detect exceptions (public).
const refreshTracking = async (req, res, next) => {
    try {
        const shipment = await db.Shipment.findByPk(req.params.id);
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        const view = await providers.tracking.track(shipment.toJSON());
        const { changes } = await applyTracking(shipment, view);
        return sendSuccess(req, res, { shipment, tracking: view, changes });
    } catch (err) { return next(err); }
};

// POST /shipments/tracking/sweep — refresh all active shipments (callable by a scheduler/worker).
const sweepTracking = async (req, res, next) => {
    try {
        const ACTIVE = ['booked', 'picked_up', 'in_transit', 'port_processing', 'customs_clearance', 'customs_hold', 'released', 'delayed', 're_routed'];
        const shipments = await db.Shipment.findAll({ where: { status: { [Op.in]: ACTIVE } }, limit: 500 });
        let advanced = 0; let exceptionsRaised = 0;
        for (const s of shipments) {
            const view = await providers.tracking.track(s.toJSON());
            const { changes } = await applyTracking(s, view);
            if (changes.statusChanged) advanced += 1;
            exceptionsRaised += changes.newExceptions.length;
        }
        return sendSuccess(req, res, { scanned: shipments.length, advanced, exceptionsRaised });
    } catch (err) { return next(err); }
};

module.exports = {
    listShipments, getShipment, createShipment, updateShipment,
    addMilestone, addException, updateShipmentStatus,
    trackShipment, refreshTracking, sweepTracking,
};
