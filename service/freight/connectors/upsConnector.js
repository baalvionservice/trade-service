'use strict';
/**
 * UpsConnector — UPS Rating / Shipping integration (PLACEHOLDER) (Prompt 10).
 *
 * Maps the canonical shipment request to a UPS Rating-API message. UPS routes on the
 * destination city/town, so a destination city is the carrier rule layered on top of
 * the base completeness checks.
 *
 * The real UPS APIs require an OAuth client + account number, so the transmit steps
 * only call the live endpoint when UPS_ENDPOINT + UPS_API_KEY are set; otherwise they
 * fall back to the deterministic simulator. UPS nests its rate reply under
 * `RateResponse.RatedShipment[]` and its booking under `ShipmentResponse.
 * ShipmentResults` with a `ShipmentIdentificationNumber` — parseQuote / parseBooking
 * collapse both into the normalized shapes.
 */

const { CarrierConnector } = require('./baseConnector');
const { httpSend } = require('./transport');
const { decideOutcome, deterministicRef, simulatePrice } = require('./simulate');
const { CARRIER, MODE, STATUS, normalizedQuote, normalizedBooking } = require('../schema');
const norm = require('../normalize');
const eta = require('../eta');

// UPS service codes: 07 = Worldwide Express, 08 = Worldwide Expedited, 11 = Standard.
const RATE_CARD = {
    [MODE.EXPRESS]: { service: '07', service_name: 'UPS Worldwide Express', base_fee: 30, rate_per_kg: 8.0, fuel_pct: 0.15, transit: 5 },
    [MODE.AIR]: { service: '08', service_name: 'UPS Worldwide Expedited', base_fee: 40, rate_per_kg: 5.8, fuel_pct: 0.13, transit: 7 },
    [MODE.ROAD]: { service: '11', service_name: 'UPS Standard', base_fee: 20, rate_per_kg: 1.0, fuel_pct: 0.08, transit: 6 },
};

class UpsConnector extends CarrierConnector {
    constructor(opts = {}) {
        super({ carrier: CARRIER.UPS, carrierName: 'UPS', ...opts });
        this.endpoint = opts.endpoint || process.env.UPS_ENDPOINT || null;
        this.apiKey = opts.apiKey || process.env.UPS_API_KEY || null;
    }

    validateRequest(request) {
        const errors = [];
        if (!request.destination || !request.destination.city) {
            errors.push({ code: 'UPS_MISSING_CITY', level: 'error', text: 'UPS requires the destination city to rate a shipment' });
        }
        return errors;
    }

    _card(mode) { return RATE_CARD[mode] || RATE_CARD[MODE.EXPRESS]; }

    buildQuoteRequest(request, ctx) {
        const card = this._card(ctx.mode);
        const chargeable = norm.chargeableWeightForMode(request, ctx.mode);
        return {
            RateRequest: {
                Shipment: {
                    Shipper: { Address: request.origin },
                    ShipTo: { Address: request.destination },
                    Service: { Code: card.service, Description: card.service_name },
                    Package: { PackageWeight: { UnitOfMeasurement: { Code: 'KGS' }, Weight: String(chargeable) } },
                },
            },
            __sim: { card, chargeable },
        };
    }

    async transmitQuote(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpSend(this, { url: `${this.endpoint}/api/rating/v1/Rate`, headers: { Authorization: `Bearer ${this.apiKey}` }, payload });
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
            RateResponse: {
                RatedShipment: [{
                    Service: { Code: card.service, Description: card.service_name },
                    TotalCharges: { CurrencyCode: this.profile.default_currency, MonetaryValue: String(amount) },
                    ItemizedCharges: surcharges.map((s) => ({ Code: s.code, Description: s.label, MonetaryValue: String(s.amount) })),
                    GuaranteedDelivery: { BusinessDaysInTransit: String(card.transit) },
                    __chargeable: chargeable,
                }],
            },
        };
    }

    parseQuote(raw, ctx) {
        const rs = (raw.RateResponse && raw.RateResponse.RatedShipment && raw.RateResponse.RatedShipment[0]) || {};
        const transit = Number((rs.GuaranteedDelivery && rs.GuaranteedDelivery.BusinessDaysInTransit) || 0);
        const surcharges = (rs.ItemizedCharges || []).map((c) => ({ code: c.Code, label: c.Description, amount: Number(c.MonetaryValue) }));
        return normalizedQuote({
            carrier: this.carrier,
            service_level: (rs.Service && rs.Service.Description) || (rs.Service && rs.Service.Code),
            mode: ctx.mode,
            amount: Number((rs.TotalCharges && rs.TotalCharges.MonetaryValue) || 0),
            currency: (rs.TotalCharges && rs.TotalCharges.CurrencyCode) || this.profile.default_currency,
            transit_days: transit,
            estimated_delivery: eta.estimateDelivery({ transitDays: transit, readyDate: ctx.request.ready_date, now: ctx.now }),
            valid_until: ctx.validUntil || null,
            surcharges,
            reliability: this.reliability,
            chargeable_weight: rs.__chargeable,
            raw,
        });
    }

    buildBookingRequest(request, quote, ctx) {
        const card = this._card(ctx.mode);
        return {
            ShipmentRequest: {
                Shipment: {
                    Shipper: { Address: request.origin },
                    ShipTo: { Address: request.destination },
                    Service: { Code: (quote && quote.raw && quote.raw.serviceCode) || card.service },
                    InvoiceLineTotal: { CurrencyCode: request.currency, MonetaryValue: String(request.declared_value) },
                },
            },
            __sim: { quote },
        };
    }

    async transmitBooking(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpSend(this, { url: `${this.endpoint}/api/shipments/v1/ship`, headers: { Authorization: `Bearer ${this.apiKey}` }, payload });
        }
        return this._simBooking(payload, ctx);
    }

    _simBooking(payload, ctx) {
        const outcome = decideOutcome(ctx.request, { ...ctx, carrier: this.carrier });
        if (!outcome.ok) {
            throw outcome.kind === 'permanent' ? this.failPermanent(outcome.reason, { code: outcome.code }) : this.failTransient(outcome.reason, { code: outcome.code });
        }
        const tracking = deterministicRef('1Z', ctx.request, this.carrier);
        return {
            ShipmentResponse: {
                Response: { ResponseStatus: { Code: '1', Description: 'Success' } },
                ShipmentResults: {
                    ShipmentIdentificationNumber: tracking,
                    PackageResults: [{ TrackingNumber: tracking, ShippingLabel: { GraphicImage: `https://www.ups.com/labels/${tracking}.gif` } }],
                },
            },
        };
    }

    parseBooking(raw, ctx) {
        const sr = (raw.ShipmentResponse && raw.ShipmentResponse.ShipmentResults) || {};
        const accepted = !!sr.ShipmentIdentificationNumber;
        const pkg = (sr.PackageResults && sr.PackageResults[0]) || {};
        return normalizedBooking({
            carrier: this.carrier,
            status: accepted ? STATUS.BOOKED : STATUS.FAILED,
            accepted,
            tracking_number: sr.ShipmentIdentificationNumber || null,
            gateway_reference: sr.ShipmentIdentificationNumber || null,
            label_url: (pkg.ShippingLabel && pkg.ShippingLabel.GraphicImage) || null,
            service_level: ctx.quote && ctx.quote.service_level,
            mode: ctx.mode,
            amount: ctx.quote && ctx.quote.amount,
            currency: ctx.quote && ctx.quote.currency,
            estimated_delivery: ctx.quote && ctx.quote.estimated_delivery,
            messages: accepted ? [] : [{ code: 'UPS_BOOK_FAILED', level: 'error', text: 'UPS did not return a shipment identification number' }],
            raw,
        });
    }
}

module.exports = { UpsConnector, RATE_CARD };
