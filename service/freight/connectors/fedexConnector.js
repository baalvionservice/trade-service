'use strict';
/**
 * FedexConnector — FedEx Express / Freight integration (PLACEHOLDER) (Prompt 10).
 *
 * Maps the canonical shipment request to a FedEx Ship-API rate/booking message.
 * FedEx rating requires the ORIGIN postal code (rates are origin-postal-zone based),
 * so that is the carrier rule layered on top of the base completeness checks.
 *
 * The real FedEx APIs require an OAuth2 client + account/meter numbers, so the
 * transmit steps only call the live endpoint when FEDEX_ENDPOINT + FEDEX_API_KEY are
 * set; otherwise they fall back to the deterministic simulator. FedEx nests its rate
 * reply under `output.rateReplyDetails[]` and its booking under
 * `output.transactionShipments[]` with a `masterTrackingNumber` — parseQuote /
 * parseBooking collapse both into the normalized shapes.
 */

const { CarrierConnector } = require('./baseConnector');
const { httpSend } = require('./transport');
const { decideOutcome, deterministicRef, simulatePrice } = require('./simulate');
const { CARRIER, MODE, STATUS, normalizedQuote, normalizedBooking } = require('../schema');
const norm = require('../normalize');
const eta = require('../eta');

const RATE_CARD = {
    [MODE.EXPRESS]: { service: 'INTERNATIONAL_PRIORITY', base_fee: 32, rate_per_kg: 8.5, fuel_pct: 0.16, transit: 4 },
    [MODE.AIR]: { service: 'INTERNATIONAL_ECONOMY', base_fee: 42, rate_per_kg: 6.0, fuel_pct: 0.14, transit: 6 },
    [MODE.ROAD]: { service: 'FEDEX_GROUND', base_fee: 22, rate_per_kg: 1.1, fuel_pct: 0.09, transit: 5 },
};

class FedexConnector extends CarrierConnector {
    constructor(opts = {}) {
        super({ carrier: CARRIER.FEDEX, carrierName: 'FedEx', ...opts });
        this.endpoint = opts.endpoint || process.env.FEDEX_ENDPOINT || null;
        this.apiKey = opts.apiKey || process.env.FEDEX_API_KEY || null;
    }

    validateRequest(request) {
        const errors = [];
        if (!request.origin || !request.origin.postal_code) {
            errors.push({ code: 'FEDEX_MISSING_ORIGIN_POSTAL', level: 'error', text: 'FedEx rating requires the origin postal code (origin-zone based rates)' });
        }
        return errors;
    }

    _card(mode) { return RATE_CARD[mode] || RATE_CARD[MODE.EXPRESS]; }

    buildQuoteRequest(request, ctx) {
        const card = this._card(ctx.mode);
        const chargeable = norm.chargeableWeightForMode(request, ctx.mode);
        return {
            accountNumber: { value: 'SIMULATED' },
            requestedShipment: {
                shipper: { address: request.origin },
                recipient: { address: request.destination },
                serviceType: card.service,
                shipDatestamp: request.ready_date,
                totalWeight: chargeable,
            },
            __sim: { card, chargeable },
        };
    }

    async transmitQuote(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpSend(this, { url: `${this.endpoint}/rate/v1/rates/quotes`, headers: { Authorization: `Bearer ${this.apiKey}` }, payload });
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
            output: {
                rateReplyDetails: [{
                    serviceType: card.service,
                    ratedShipmentDetails: [{
                        totalNetCharge: amount,
                        currency: this.profile.default_currency,
                        shipmentRateDetail: { surCharges: surcharges.map((s) => ({ type: s.code, description: s.label, amount: s.amount })) },
                    }],
                    commit: { transitDays: { description: `${card.transit} business days`, count: card.transit } },
                    __chargeable: chargeable,
                }],
            },
        };
    }

    parseQuote(raw, ctx) {
        const detail = (raw.output && raw.output.rateReplyDetails && raw.output.rateReplyDetails[0]) || {};
        const rated = (detail.ratedShipmentDetails && detail.ratedShipmentDetails[0]) || {};
        const transit = (detail.commit && detail.commit.transitDays && detail.commit.transitDays.count) || 0;
        const surcharges = ((rated.shipmentRateDetail && rated.shipmentRateDetail.surCharges) || [])
            .map((s) => ({ code: s.type, label: s.description, amount: s.amount }));
        return normalizedQuote({
            carrier: this.carrier,
            service_level: detail.serviceType,
            mode: ctx.mode,
            amount: rated.totalNetCharge,
            currency: rated.currency,
            transit_days: transit,
            estimated_delivery: eta.estimateDelivery({ transitDays: transit, readyDate: ctx.request.ready_date, now: ctx.now }),
            valid_until: ctx.validUntil || null,
            surcharges,
            reliability: this.reliability,
            chargeable_weight: detail.__chargeable,
            raw,
        });
    }

    buildBookingRequest(request, quote, ctx) {
        return {
            requestedShipment: {
                shipper: { address: request.origin },
                recipient: { address: request.destination },
                serviceType: (quote && quote.service_level) || this._card(ctx.mode).service,
                shipDatestamp: request.ready_date,
                customsClearanceDetail: { totalCustomsValue: { amount: request.declared_value, currency: request.currency } },
            },
            __sim: { quote },
        };
    }

    async transmitBooking(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpSend(this, { url: `${this.endpoint}/ship/v1/shipments`, headers: { Authorization: `Bearer ${this.apiKey}` }, payload });
        }
        return this._simBooking(payload, ctx);
    }

    _simBooking(payload, ctx) {
        const outcome = decideOutcome(ctx.request, { ...ctx, carrier: this.carrier });
        if (!outcome.ok) {
            throw outcome.kind === 'permanent' ? this.failPermanent(outcome.reason, { code: outcome.code }) : this.failTransient(outcome.reason, { code: outcome.code });
        }
        const tracking = deterministicRef('FX', ctx.request, this.carrier);
        return {
            output: {
                transactionShipments: [{
                    masterTrackingNumber: tracking,
                    serviceType: ctx.quote && ctx.quote.service_level,
                    pieceResponses: [{ trackingNumber: tracking }],
                    shipmentDocuments: [{ contentType: 'LABEL', url: `https://www.fedex.com/labels/${tracking}.pdf` }],
                }],
            },
        };
    }

    parseBooking(raw, ctx) {
        const ts = (raw.output && raw.output.transactionShipments && raw.output.transactionShipments[0]) || {};
        const accepted = !!ts.masterTrackingNumber;
        const label = (ts.shipmentDocuments || []).find((d) => d.contentType === 'LABEL');
        return normalizedBooking({
            carrier: this.carrier,
            status: accepted ? STATUS.BOOKED : STATUS.FAILED,
            accepted,
            tracking_number: ts.masterTrackingNumber || null,
            gateway_reference: ts.masterTrackingNumber || null,
            label_url: label ? label.url : null,
            service_level: ts.serviceType || (ctx.quote && ctx.quote.service_level),
            mode: ctx.mode,
            amount: ctx.quote && ctx.quote.amount,
            currency: ctx.quote && ctx.quote.currency,
            estimated_delivery: ctx.quote && ctx.quote.estimated_delivery,
            messages: accepted ? [] : [{ code: 'FEDEX_BOOK_FAILED', level: 'error', text: 'FedEx did not return a master tracking number' }],
            raw,
        });
    }
}

module.exports = { FedexConnector, RATE_CARD };
