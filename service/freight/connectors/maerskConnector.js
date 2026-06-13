'use strict';
/**
 * MaerskConnector — Maersk Line ocean-freight integration (PLACEHOLDER) (Prompt 10).
 *
 * Maps the canonical shipment request to a Maersk Spot/Booking-API message. Maersk
 * serves OCEAN (and inland ROAD legs), not express/air — so the registry only routes
 * ocean-eligible shipments here. Ocean freight crosses customs, so a declared
 * commercial value is the carrier rule layered on top of the base completeness checks.
 *
 * The real Maersk APIs require a Consumer-Key + a registered party, so the transmit
 * steps only call the live endpoint when MAERSK_ENDPOINT + MAERSK_API_KEY are set;
 * otherwise they fall back to the deterministic simulator. Maersk returns spot rates
 * under `spotRates[]` and a booking under `booking` with a `carrierBookingReference`
 * — parseQuote / parseBooking collapse both into the normalized shapes.
 */

const { CarrierConnector } = require('./baseConnector');
const { httpSend } = require('./transport');
const { decideOutcome, deterministicRef, simulatePrice } = require('./simulate');
const { CARRIER, MODE, STATUS, normalizedQuote, normalizedBooking } = require('../schema');
const norm = require('../normalize');
const eta = require('../eta');

const RATE_CARD = {
    [MODE.OCEAN]: { service: 'OCEAN_FCL', base_fee: 600, rate_per_kg: 0.35, fuel_pct: 0.05, transit: 28 },
    [MODE.ROAD]: { service: 'INLAND_HAULAGE', base_fee: 120, rate_per_kg: 0.9, fuel_pct: 0.08, transit: 9 },
};

// Maersk native booking status → normalized booking status.
const MAERSK_STATUS_MAP = {
    CONFIRMED: STATUS.BOOKED,
    PENDING: STATUS.BOOKING,
    REJECTED: STATUS.FAILED,
};

class MaerskConnector extends CarrierConnector {
    constructor(opts = {}) {
        super({ carrier: CARRIER.MAERSK, carrierName: 'Maersk Line', ...opts });
        this.endpoint = opts.endpoint || process.env.MAERSK_ENDPOINT || null;
        this.apiKey = opts.apiKey || process.env.MAERSK_API_KEY || null;
    }

    validateRequest(request) {
        const errors = [];
        if (!(Number(request.declared_value) > 0)) {
            errors.push({ code: 'MAERSK_MISSING_VALUE', level: 'error', text: 'Maersk ocean freight requires a declared commercial value for customs' });
        }
        return errors;
    }

    _card(mode) { return RATE_CARD[mode] || RATE_CARD[MODE.OCEAN]; }

    buildQuoteRequest(request, ctx) {
        const card = this._card(ctx.mode);
        const chargeable = norm.chargeableWeightForMode(request, ctx.mode);
        return {
            origin: { countryCode: request.origin && request.origin.country, cityName: request.origin && request.origin.city },
            destination: { countryCode: request.destination && request.destination.country, cityName: request.destination && request.destination.city },
            product: card.service,
            cargoWeight: chargeable,
            cargoWeightUnit: 'KGS',
            departureDate: request.ready_date,
            __sim: { card, chargeable },
        };
    }

    async transmitQuote(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpSend(this, { url: `${this.endpoint}/products/ocean-products`, headers: { 'Consumer-Key': this.apiKey }, payload });
        }
        return this._simRate(payload, ctx);
    }

    _simRate(payload, ctx) {
        const outcome = decideOutcome(ctx.request, { ...ctx, carrier: this.carrier });
        if (!outcome.ok) {
            throw outcome.kind === 'permanent' ? this.failPermanent(outcome.reason, { code: outcome.code }) : this.failTransient(outcome.reason, { code: outcome.code });
        }
        const { card, chargeable } = payload.__sim;
        const { amount, surcharges } = simulatePrice(card, chargeable, ctx.request);
        return {
            spotRates: [{
                rateId: deterministicRef('SR', ctx.request, this.carrier),
                product: card.service,
                amount,
                currency: this.profile.default_currency,
                charges: surcharges.map((s) => ({ chargeType: s.code, chargeName: s.label, amount: s.amount })),
                transitTime: { days: card.transit },
                __chargeable: chargeable,
            }],
        };
    }

    parseQuote(raw, ctx) {
        const sr = (raw.spotRates && raw.spotRates[0]) || {};
        const transit = (sr.transitTime && sr.transitTime.days) || 0;
        const surcharges = (sr.charges || []).map((c) => ({ code: c.chargeType, label: c.chargeName, amount: c.amount }));
        return normalizedQuote({
            carrier: this.carrier,
            service_level: sr.product,
            mode: ctx.mode,
            amount: sr.amount,
            currency: sr.currency,
            transit_days: transit,
            estimated_delivery: eta.estimateDelivery({ transitDays: transit, readyDate: ctx.request.ready_date, now: ctx.now }),
            valid_until: ctx.validUntil || null,
            surcharges,
            reliability: this.reliability,
            chargeable_weight: sr.__chargeable,
            raw,
        });
    }

    buildBookingRequest(request, quote, ctx) {
        return {
            product: (quote && quote.service_level) || this._card(ctx.mode).service,
            origin: { countryCode: request.origin && request.origin.country },
            destination: { countryCode: request.destination && request.destination.country },
            cargo: { description: request.reference, value: request.declared_value, currency: request.currency },
            departureDate: request.ready_date,
            __sim: { quote },
        };
    }

    async transmitBooking(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpSend(this, { url: `${this.endpoint}/bookings`, headers: { 'Consumer-Key': this.apiKey }, payload });
        }
        return this._simBooking(payload, ctx);
    }

    _simBooking(payload, ctx) {
        const outcome = decideOutcome(ctx.request, { ...ctx, carrier: this.carrier });
        if (!outcome.ok) {
            throw outcome.kind === 'permanent' ? this.failPermanent(outcome.reason, { code: outcome.code }) : this.failTransient(outcome.reason, { code: outcome.code });
        }
        const ref = deterministicRef('MAEU', ctx.request, this.carrier);
        return {
            booking: {
                carrierBookingReference: ref,
                bookingStatus: 'CONFIRMED',
                transportDocumentReference: `BL${ref}`,
            },
        };
    }

    parseBooking(raw, ctx) {
        const b = raw.booking || {};
        const native = String(b.bookingStatus || 'PENDING').toUpperCase();
        const status = MAERSK_STATUS_MAP[native] || STATUS.BOOKING;
        const accepted = status === STATUS.BOOKED;
        return normalizedBooking({
            carrier: this.carrier,
            status,
            accepted,
            tracking_number: b.carrierBookingReference || null,
            gateway_reference: b.transportDocumentReference || b.carrierBookingReference || null,
            label_url: null, // ocean issues a Bill of Lading, not a parcel label
            service_level: ctx.quote && ctx.quote.service_level,
            mode: ctx.mode,
            amount: ctx.quote && ctx.quote.amount,
            currency: ctx.quote && ctx.quote.currency,
            estimated_delivery: ctx.quote && ctx.quote.estimated_delivery,
            messages: accepted ? [] : [{ code: 'MAERSK_BOOK_PENDING', level: 'warning', text: `Maersk booking status ${native}` }],
            raw,
        });
    }
}

module.exports = { MaerskConnector, RATE_CARD, MAERSK_STATUS_MAP };
