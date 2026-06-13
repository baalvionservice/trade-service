'use strict';
/**
 * DhlConnector — DHL Express / Global Forwarding integration (PLACEHOLDER) (Prompt 10).
 *
 * Maps the canonical shipment request to a MyDHL-API rate/booking message. DHL
 * Express needs the destination postal code to route + commit a time-definite
 * service, so that is the carrier rule layered on top of the base completeness checks.
 *
 * The real MyDHL API requires an OAuth client + an account number, so the transmit
 * steps only call the live endpoint when DHL_ENDPOINT + DHL_API_KEY are set;
 * otherwise they fall back to the deterministic simulator. DHL's native rate reply
 * nests under `products[]` with `totalPrice[]` + `deliveryCapabilities`, and its
 * booking ack returns a `shipmentTrackingNumber` — parseQuote / parseBooking
 * collapse both into the normalized shapes.
 */

const { CarrierConnector } = require('./baseConnector');
const { httpSend } = require('./transport');
const { decideOutcome, deterministicRef, simulatePrice } = require('./simulate');
const { CARRIER, MODE, STATUS, DEFAULT_QUOTE_TTL_HOURS, normalizedQuote, normalizedBooking } = require('../schema');
const norm = require('../normalize');
const eta = require('../eta');

// Rate cards by mode: base fee + per-kg + fuel % + committed transit days.
const RATE_CARD = {
    [MODE.EXPRESS]: { service: 'EXPRESS_WORLDWIDE', base_fee: 35, rate_per_kg: 9.0, fuel_pct: 0.18, transit: 3 },
    [MODE.AIR]: { service: 'AIR_ECONOMY', base_fee: 45, rate_per_kg: 6.5, fuel_pct: 0.15, transit: 6 },
    [MODE.ROAD]: { service: 'ECONOMY_SELECT', base_fee: 25, rate_per_kg: 1.2, fuel_pct: 0.10, transit: 4 },
};

class DhlConnector extends CarrierConnector {
    constructor(opts = {}) {
        super({ carrier: CARRIER.DHL, carrierName: 'DHL', ...opts });
        this.endpoint = opts.endpoint || process.env.DHL_ENDPOINT || null;
        this.apiKey = opts.apiKey || process.env.DHL_API_KEY || null;
    }

    validateRequest(request) {
        const errors = [];
        if (!request.destination || !request.destination.postal_code) {
            errors.push({ code: 'DHL_MISSING_POSTAL', level: 'error', text: 'DHL Express requires the destination postal code to route a time-definite service' });
        }
        return errors;
    }

    _card(mode) { return RATE_CARD[mode] || RATE_CARD[MODE.EXPRESS]; }

    buildQuoteRequest(request, ctx) {
        const card = this._card(ctx.mode);
        const chargeable = norm.chargeableWeightForMode(request, ctx.mode);
        return {
            customerDetails: { shipperDetails: request.origin, receiverDetails: request.destination },
            plannedShippingDateAndTime: request.ready_date,
            productCode: card.service,
            unitOfMeasurement: 'metric',
            chargeableWeight: chargeable,
            __sim: { card, chargeable },
        };
    }

    async transmitQuote(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpSend(this, { url: `${this.endpoint}/rates`, headers: { 'DHL-API-Key': this.apiKey }, payload });
        }
        return this._simRate(payload, ctx);
    }

    _simRate(payload, ctx) {
        const outcome = decideOutcome(ctx.request, { ...ctx, carrier: this.carrier });
        if (!outcome.ok) {
            const err = outcome.kind === 'permanent' ? this.failPermanent(outcome.reason, { code: outcome.code }) : this.failTransient(outcome.reason, { code: outcome.code });
            throw err;
        }
        const { card, chargeable } = payload.__sim;
        const { amount, surcharges } = simulatePrice(card, chargeable, ctx.request);
        // DHL native rate shape.
        return {
            products: [{
                productName: card.service,
                productCode: card.service,
                totalPrice: [{ price: amount, priceCurrency: this.profile.default_currency }],
                detailedPriceBreakdown: surcharges.map((s) => ({ name: s.label, price: s.amount, typeCode: s.code })),
                deliveryCapabilities: { totalTransitDays: card.transit },
                __chargeable: chargeable,
            }],
        };
    }

    parseQuote(raw, ctx) {
        const p = (raw.products && raw.products[0]) || {};
        const price = (p.totalPrice && p.totalPrice[0]) || {};
        const transit = (p.deliveryCapabilities && p.deliveryCapabilities.totalTransitDays) || 0;
        const surcharges = (p.detailedPriceBreakdown || []).map((b) => ({ code: b.typeCode, label: b.name, amount: b.price }));
        return normalizedQuote({
            carrier: this.carrier,
            service_level: p.productName || p.productCode,
            mode: ctx.mode,
            amount: price.price,
            currency: price.priceCurrency,
            transit_days: transit,
            estimated_delivery: eta.estimateDelivery({ transitDays: transit, readyDate: ctx.request.ready_date, now: ctx.now }),
            valid_until: ctx.validUntil || null,
            surcharges,
            reliability: this.reliability,
            chargeable_weight: p.__chargeable,
            raw,
        });
    }

    buildBookingRequest(request, quote, ctx) {
        return {
            plannedShippingDateAndTime: request.ready_date,
            productCode: (quote && quote.service_level) || this._card(ctx.mode).service,
            customerDetails: { shipperDetails: request.origin, receiverDetails: request.destination },
            content: { unitOfMeasurement: 'metric', declaredValue: request.declared_value, declaredValueCurrency: request.currency },
            __sim: { quote },
        };
    }

    async transmitBooking(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpSend(this, { url: `${this.endpoint}/shipments`, headers: { 'DHL-API-Key': this.apiKey }, payload });
        }
        return this._simBooking(payload, ctx);
    }

    _simBooking(payload, ctx) {
        const outcome = decideOutcome(ctx.request, { ...ctx, carrier: this.carrier });
        if (!outcome.ok) {
            throw outcome.kind === 'permanent' ? this.failPermanent(outcome.reason, { code: outcome.code }) : this.failTransient(outcome.reason, { code: outcome.code });
        }
        const tracking = deterministicRef('JD', ctx.request, this.carrier);
        return {
            shipmentTrackingNumber: tracking,
            status: 'SUCCESS',
            documents: [{ typeCode: 'label', url: `https://track.dhl.com/labels/${tracking}.pdf` }],
            estimatedDeliveryDate: ctx.quote && ctx.quote.estimated_delivery,
        };
    }

    parseBooking(raw, ctx) {
        const accepted = String(raw.status || '').toUpperCase() === 'SUCCESS' && !!raw.shipmentTrackingNumber;
        const label = (raw.documents || []).find((d) => d.typeCode === 'label');
        return normalizedBooking({
            carrier: this.carrier,
            status: accepted ? STATUS.BOOKED : STATUS.FAILED,
            accepted,
            tracking_number: raw.shipmentTrackingNumber || null,
            gateway_reference: raw.shipmentTrackingNumber || null,
            label_url: label ? label.url : null,
            service_level: ctx.quote && ctx.quote.service_level,
            mode: ctx.mode,
            amount: ctx.quote && ctx.quote.amount,
            currency: ctx.quote && ctx.quote.currency,
            estimated_delivery: raw.estimatedDeliveryDate || (ctx.quote && ctx.quote.estimated_delivery),
            messages: accepted ? [] : [{ code: 'DHL_BOOK_FAILED', level: 'error', text: 'DHL did not return a tracking number' }],
            raw,
        });
    }
}

module.exports = { DhlConnector, RATE_CARD, DEFAULT_QUOTE_TTL_HOURS };
