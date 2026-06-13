'use strict';
/**
 * UAEConnector — Dubai Customs Mirsal 2 gateway (PLACEHOLDER) (Prompt 9).
 *
 * Maps a canonical declaration to a Dubai Customs (Mirsal 2) declaration and
 * submits it. The UAE keys the trader on a Customs Business Code / TRN, so the
 * jurisdiction rule is "the trading party must carry a tax_id (TRN) or a business
 * code in metadata". Mirsal returns a `declarationNumber` and a `mirsalStatus`
 * (CLEARED / PENDING / REJECTED), collapsed by parseResponse into the normalized
 * shape.
 *
 * The live channel needs Dubai Trade portal credentials, so `transmit()` only
 * calls the real endpoint when MIRSAL_ENDPOINT + MIRSAL_API_KEY are set; otherwise
 * it falls back to the deterministic simulator.
 */

const { CustomsConnector } = require('./baseConnector');
const { httpTransmit } = require('./transport');
const { decideOutcome, deterministicRef } = require('./simulate');
const { CHANNEL, STATUS } = require('../schema');

// Mirsal native status → normalized status.
const MIRSAL_STATUS_MAP = {
    CLEARED: STATUS.ACCEPTED,
    APPROVED: STATUS.ACCEPTED,
    PENDING: STATUS.SUBMITTED,
    UNDER_INSPECTION: STATUS.SUBMITTED,
    REJECTED: STATUS.REJECTED,
    CANCELLED: STATUS.REJECTED,
};

class UAEConnector extends CustomsConnector {
    constructor(opts = {}) {
        super({ channel: CHANNEL.UAE_MIRSAL, gatewayName: 'Mirsal 2', ...opts });
        this.endpoint = opts.endpoint || process.env.MIRSAL_ENDPOINT || null;
        this.apiKey = opts.apiKey || process.env.MIRSAL_API_KEY || null;
    }

    validateDeclaration(declaration) {
        const errors = [];
        const trader = declaration.entry_type === 'export' ? declaration.exporter : declaration.importer;
        const businessCode = trader && (trader.tax_id || (declaration.metadata && declaration.metadata.business_code));
        if (!businessCode) {
            errors.push({ code: 'AE_MISSING_BUSINESS_CODE', level: 'error', text: 'Mirsal requires a Customs Business Code / TRN on the trading party' });
        }
        return errors;
    }

    buildPayload(declaration) {
        const isExport = declaration.entry_type === 'export';
        const trader = (isExport ? declaration.exporter : declaration.importer) || {};
        return {
            declarationType: isExport ? 'EX' : 'IM', // Export / Import
            regime: (declaration.metadata && declaration.metadata.regime) || 'IMPORT_FOR_HOME_CONSUMPTION',
            businessCode: trader.tax_id || (declaration.metadata && declaration.metadata.business_code) || null,
            customsOffice: (declaration.metadata && declaration.metadata.port_code) || 'JEBEL_ALI',
            totalValue: declaration.customs_value,
            currency: declaration.currency,
            goods: declaration.line_items.map((l) => ({
                hsCode: l.hs_code,
                description: l.description,
                quantity: l.quantity,
                unit: l.unit,
                origin: l.origin_country,
                value: l.value,
            })),
        };
    }

    async transmit(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpTransmit(this, {
                url: this.endpoint,
                headers: { 'X-Mirsal-Key': this.apiKey },
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
            err.raw = { declarationNumber: null, mirsalStatus: 'REJECTED', reason: outcome.code };
            throw err;
        }
        const pending = outcome.mode === 'pending';
        return {
            declarationNumber: deterministicRef('DXB', declaration),
            mirsalStatus: pending ? 'PENDING' : 'CLEARED',
            reason: null,
        };
    }

    parseResponse(raw) {
        const s = String((raw && raw.mirsalStatus) || 'PENDING').toUpperCase();
        const status = MIRSAL_STATUS_MAP[s] || STATUS.SUBMITTED;
        return this.normalize({
            status,
            accepted: status === STATUS.ACCEPTED,
            gateway_reference: (raw && raw.declarationNumber) || null,
            gateway_status: s,
            messages: status === STATUS.REJECTED
                ? [{ code: (raw && raw.reason) || 'REJECTED', level: 'error', text: `Mirsal: ${(raw && raw.reason) || 'rejected'}` }]
                : [],
            retryable: false,
            raw: raw || {},
        });
    }
}

module.exports = { UAEConnector };
