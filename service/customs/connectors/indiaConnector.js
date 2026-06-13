'use strict';
/**
 * IndiaConnector — CBIC ICEGATE gateway (PLACEHOLDER) (Prompt 9).
 *
 * Maps a canonical declaration to an India Bill of Entry (import) / Shipping Bill
 * (export) message and submits it to ICEGATE. India mandates the Importer-Exporter
 * Code (IEC) on the trading party, so that is the jurisdiction rule layered on top
 * of the base completeness checks.
 *
 * The real ICEGATE channel requires a registered ICEGATE id + digital signature +
 * the message-exchange (MEF) enrolment, so `transmit()` only calls the live
 * endpoint when ICEGATE_ENDPOINT + ICEGATE_API_KEY are set; otherwise it falls
 * back to the deterministic simulator. ICEGATE's native ack uses a jobId + a
 * Bill-of-Entry number (`beNo`) and an `iceStatus`, all of which parseResponse
 * collapses into the normalized shape.
 */

const { CustomsConnector } = require('./baseConnector');
const { httpTransmit } = require('./transport');
const { decideOutcome, deterministicRef } = require('./simulate');
const { CHANNEL, STATUS } = require('../schema');

// ICEGATE native status → normalized status.
const ICE_STATUS_MAP = {
    REGISTERED: STATUS.ACCEPTED,
    ASSESSED: STATUS.ACCEPTED,
    OOC: STATUS.ACCEPTED,        // Out Of Charge — goods cleared
    PENDING: STATUS.SUBMITTED,
    QUEUED: STATUS.SUBMITTED,
    REJECTED: STATUS.REJECTED,
};

class IndiaConnector extends CustomsConnector {
    constructor(opts = {}) {
        super({ channel: CHANNEL.ICEGATE, gatewayName: 'ICEGATE', ...opts });
        this.endpoint = opts.endpoint || process.env.ICEGATE_ENDPOINT || null;
        this.apiKey = opts.apiKey || process.env.ICEGATE_API_KEY || null;
    }

    validateDeclaration(declaration) {
        const errors = [];
        const trader = declaration.entry_type === 'export' ? declaration.exporter : declaration.importer;
        if (!trader || !trader.iec) {
            errors.push({ code: 'IN_MISSING_IEC', level: 'error', text: 'ICEGATE requires the Importer-Exporter Code (IEC) on the trading party' });
        }
        if (!declaration.incoterm) {
            errors.push({ code: 'IN_MISSING_INCOTERM', level: 'error', text: 'ICEGATE requires an Incoterm on the declaration' });
        }
        return errors;
    }

    buildPayload(declaration) {
        const isExport = declaration.entry_type === 'export';
        return {
            messageType: isExport ? 'SB' : 'BE', // Shipping Bill / Bill of Entry
            iec: (isExport ? declaration.exporter : declaration.importer || {}).iec || null,
            portCode: (declaration.metadata && declaration.metadata.port_code) || 'INNSA1',
            invoiceCurrency: declaration.currency,
            assessableValue: declaration.customs_value,
            incoterm: declaration.incoterm,
            itemDetails: declaration.line_items.map((l) => ({
                ctsh: l.hs_code,           // Customs Tariff Sub-Heading
                description: l.description,
                qty: l.quantity,
                uqc: l.unit,               // Unit Quantity Code
                unitPrice: l.unit_value,
                origin: l.origin_country,
            })),
        };
    }

    async transmit(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpTransmit(this, {
                url: this.endpoint,
                headers: { 'X-ICEGATE-Key': this.apiKey },
                payload,
            });
        }
        return this._simulate(ctx.declaration, ctx);
    }

    _simulate(declaration, ctx) {
        const outcome = decideOutcome(declaration, ctx);
        if (!outcome.ok) {
            const err = outcome.kind === 'permanent'
                ? this.failPermanent(outcome.reason, { code: outcome.code })
                : this.failTransient(outcome.reason, { code: outcome.code });
            err.raw = { jobId: deterministicRef('ICEJOB', declaration), iceStatus: 'REJECTED', errors: [outcome.code] };
            throw err;
        }
        const pending = outcome.mode === 'pending';
        return {
            jobId: deterministicRef('ICEJOB', declaration),
            beNo: pending ? null : deterministicRef('BE', declaration),
            iceStatus: pending ? 'PENDING' : 'REGISTERED',
            errors: [],
        };
    }

    parseResponse(raw) {
        const ice = String((raw && raw.iceStatus) || 'PENDING').toUpperCase();
        const status = ICE_STATUS_MAP[ice] || STATUS.SUBMITTED;
        const messages = Array.isArray(raw && raw.errors)
            ? raw.errors.map((e) => ({ code: String(e), level: 'error', text: `ICEGATE: ${e}` }))
            : [];
        return this.normalize({
            status,
            accepted: status === STATUS.ACCEPTED,
            gateway_reference: (raw && raw.beNo) || (raw && raw.jobId) || null,
            gateway_status: ice,
            messages,
            retryable: false,
            raw: raw || {},
        });
    }
}

module.exports = { IndiaConnector };
