'use strict';
/**
 * Freight Booking (Logistics #1) — real backend for the GTI carrier marketplace + quote engine.
 * Replaces the generic-store/client-side derivation in src/services/carrier-service.ts:
 *   - GET  /carriers              → typed carrier registry (global marketplace)
 *   - GET  /carriers/:id          → one carrier
 *   - GET  /shipping_quotes?orderId=  → ENGINE: compute + persist a quote per carrier for the order
 *   - POST /shipping_selections   → mark the chosen quote selected (booking creates the Shipment via /shipments)
 */
const db = require('../models');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

// ── mappers (snake_case row → frontend camelCase shape) ──────────────────────
const carrierToApi = (c) => ({
    id: c.id,
    name: c.name,
    rating: Number(c.rating),
    regions: c.regions || [],
    avgDeliveryTime: c.avg_delivery_time,
    startingPrice: Number(c.starting_price),
    logo: c.logo,
    description: c.description,
    specializations: c.specializations || [],
    modes: c.modes || [],
    reliability: c.reliability,
});

const quoteToApi = (q) => ({
    id: q.id,
    orderId: q.order_id,
    carrierId: q.carrier_id,
    carrierName: q.carrier_name,
    mode: q.mode,
    price: Number(q.price),
    currency: q.currency,
    estimatedDays: q.estimated_days,
    reliability: q.reliability,
    status: q.status,
    validUntil: q.valid_until,
});

// ── handlers ─────────────────────────────────────────────────────────────────
const listCarriers = async (req, res, next) => {
    try {
        const where = { active: true };
        const rows = await db.Carrier.findAll({ where, order: [['rating', 'DESC']] });
        // Array under `data` (store-compatible shape; the frontend's toList() handles it).
        return sendSuccess(req, res, rows.map(carrierToApi));
    } catch (err) { return next(err); }
};

const getCarrier = async (req, res, next) => {
    try {
        const c = await db.Carrier.findByPk(req.params.id);
        if (!c) return next(new AppError('NOT_FOUND', 'Carrier not found', 404));
        return sendSuccess(req, res, carrierToApi(c));
    } catch (err) { return next(err); }
};

// Quote engine: price = base_fee + rate_per_kg * chargeable_weight; ETA + reliability from the carrier.
const QUOTE_TTL_HOURS = 72;
const getQuotes = async (req, res, next) => {
    try {
        const orderId = req.query.orderId || req.query.order_id;
        if (!orderId) return next(new AppError('BAD_REQUEST', 'orderId is required', 400));

        const order = await db.Order.findByPk(orderId).catch(() => null);
        const currency = (order && order.currency) || 'USD';
        // Notional chargeable weight from the order quantity (min floor so a quote is always meaningful).
        const chargeableWeight = Math.max(Number(order && order.quantity) || 0, 100);

        const carriers = await db.Carrier.findAll({ where: { active: true }, order: [['rating', 'DESC']] });
        const validUntil = new Date(Date.now() + QUOTE_TTL_HOURS * 3600 * 1000);

        // Preserve a prior selection/booking when re-quoting (re-pricing must not reset status).
        const existing = await db.FreightQuote.findAll({ where: { order_id: String(orderId) } });
        const prevByCarrier = new Map(existing.map((q) => [q.carrier_id, q]));

        const quotes = [];
        for (const c of carriers) {
            const price = Math.round(Number(c.base_fee) + Number(c.rate_per_kg) * chargeableWeight);
            const mode = (c.modes && c.modes[0]) || 'sea';
            const prev = prevByCarrier.get(c.id);
            const status = prev && (prev.status === 'selected' || prev.status === 'booked') ? prev.status : 'quoted';
            const row = {
                id: `Q-${orderId}-${c.id}`,
                order_id: String(orderId),
                carrier_id: c.id,
                carrier_name: c.name,
                mode,
                price,
                currency,
                estimated_days: c.transit_days,
                reliability: c.reliability,
                status,
                valid_until: validUntil,
                metadata: { chargeableWeight },
            };
            // Upsert by PK so re-quoting refreshes prices without duplicating rows.
            await db.FreightQuote.upsert(row);
            quotes.push(row);
        }
        // cheapest first (typical buyer default)
        quotes.sort((a, b) => a.price - b.price);
        return sendSuccess(req, res, quotes.map(quoteToApi));
    } catch (err) { return next(err); }
};

const selectCarrier = async (req, res, next) => {
    try {
        const { orderId, carrierId, quoteId } = req.body || {};
        if (!orderId || !carrierId) return next(new AppError('BAD_REQUEST', 'orderId and carrierId are required', 400));

        // Mark the chosen quote selected (and de-select the order's other quotes).
        if (quoteId) {
            await db.FreightQuote.update({ status: 'quoted' }, { where: { order_id: String(orderId) } });
            await db.FreightQuote.update({ status: 'selected' }, { where: { id: quoteId } });
        }
        const selected = quoteId ? await db.FreightQuote.findByPk(quoteId) : null;
        return sendSuccess(req, res, {
            orderId, carrierId, quoteId: quoteId || null,
            selectedAt: new Date().toISOString(),
            quote: selected ? quoteToApi(selected) : null,
        }, 201);
    } catch (err) { return next(err); }
};

module.exports = { listCarriers, getCarrier, getQuotes, selectCarrier };
