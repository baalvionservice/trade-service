'use strict';
/**
 * EUConnector — EU Customs Declaration System / UCC gateway (PLACEHOLDER) (Prompt 9).
 *
 * Maps a canonical declaration to a UCC H1/H7 import (or B1 export) declaration and
 * submits it to the member-state CDS. The EU keys every economic operator on an
 * EORI number, so the jurisdiction rule is "the declarant (or the import/export
 * party) must carry an EORI". CDS returns a Movement Reference Number (MRN) and a
 * `declarationStatus`, which parseResponse collapses into the normalized shape.
 *
 * One connector serves all 27 member states; the specific destination country is
 * carried in the payload (`memberState`) for routing. The live channel needs the
 * member-state CDS credentials, so `transmit()` only calls the real endpoint when
 * EU_CDS_ENDPOINT + EU_CDS_API_KEY are set; otherwise it simulates deterministically.
 */

const { CustomsConnector } = require('./baseConnector');
const { httpTransmit } = require('./transport');
const { decideOutcome, deterministicRef } = require('./simulate');
const { CHANNEL, STATUS } = require('../schema');

// CDS native declarationStatus → normalized status.
const CDS_STATUS_MAP = {
    ACCEPTED: STATUS.ACCEPTED,
    RELEASED: STATUS.ACCEPTED,
    CLEARED: STATUS.ACCEPTED,
    REGISTERED: STATUS.SUBMITTED,
    UNDER_RISK: STATUS.SUBMITTED,
    PENDING: STATUS.SUBMITTED,
    REJECTED: STATUS.REJECTED,
    INVALIDATED: STATUS.REJECTED,
};

class EUConnector extends CustomsConnector {
    constructor(opts = {}) {
        super({ channel: CHANNEL.EU_CDS, gatewayName: 'EU CDS', ...opts });
        this.endpoint = opts.endpoint || process.env.EU_CDS_ENDPOINT || null;
        this.apiKey = opts.apiKey || process.env.EU_CDS_API_KEY || null;
    }

    validateDeclaration(declaration) {
        const errors = [];
        const party = declaration.declarant
            || (declaration.entry_type === 'export' ? declaration.exporter : declaration.importer);
        if (!party || !party.eori) {
            errors.push({ code: 'EU_MISSING_EORI', level: 'error', text: 'CDS requires a valid EORI number on the declarant / trading party' });
        }
        // CDS rejects non-CN8 (8-digit Combined Nomenclature) commodity codes.
        declaration.line_items.forEach((l) => {
            const digits = String(l.hs_code || '').replace(/\D/g, '');
            if (digits.length < 8) {
                errors.push({ code: 'EU_SHORT_CN', level: 'error', text: `Line ${l.line_no}: CDS requires an 8-digit CN commodity code` });
            }
        });
        return errors;
    }

    buildPayload(declaration) {
        const isExport = declaration.entry_type === 'export';
        const party = declaration.declarant
            || (isExport ? declaration.exporter : declaration.importer) || {};
        return {
            declarationType: isExport ? 'B1' : 'H1',
            memberState: declaration.destination_country,
            declarantEori: party.eori,
            statisticalValue: declaration.customs_value,
            invoiceCurrency: declaration.currency,
            goodsItems: declaration.line_items.map((l, i) => ({
                itemNumber: i + 1,
                commodityCode: String(l.hs_code || '').replace(/\D/g, ''),
                goodsDescription: l.description,
                netMass: l.quantity,
                originCountry: l.origin_country,
                itemValue: l.value,
            })),
        };
    }

    async transmit(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpTransmit(this, {
                url: this.endpoint,
                headers: { Authorization: `Bearer ${this.apiKey}`, 'X-CDS-Member-State': payload.memberState || '' },
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
            err.raw = { mrn: null, declarationStatus: 'REJECTED', errors: [outcome.code] };
            throw err;
        }
        const pending = outcome.mode === 'pending';
        return {
            mrn: pending ? null : deterministicRef('MRN', declaration),
            declarationStatus: pending ? 'REGISTERED' : 'ACCEPTED',
            errors: [],
        };
    }

    parseResponse(raw) {
        const s = String((raw && raw.declarationStatus) || 'REGISTERED').toUpperCase();
        const status = CDS_STATUS_MAP[s] || STATUS.SUBMITTED;
        const messages = Array.isArray(raw && raw.errors)
            ? raw.errors.map((e) => ({ code: String(e), level: 'error', text: `CDS: ${e}` }))
            : [];
        return this.normalize({
            status,
            accepted: status === STATUS.ACCEPTED,
            gateway_reference: (raw && raw.mrn) || null,
            gateway_status: s,
            messages,
            retryable: false,
            raw: raw || {},
        });
    }
}

module.exports = { EUConnector };
