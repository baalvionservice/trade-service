'use strict';
/**
 * USConnector — CBP ACE gateway (PLACEHOLDER) (Prompt 9).
 *
 * Maps a canonical declaration to a US Customs ACE entry summary (CBP Form 7501
 * data set) and submits it to the Automated Commercial Environment. ACE keys the
 * importer of record on an EIN / CBP-assigned number, so the jurisdiction rule is
 * "the importer must carry a tax_id". ACE's native ack returns an `entryNumber`
 * and a numeric `statusCode` (01 = accepted, 03 = rejected, 07 = under review),
 * which parseResponse collapses into the normalized shape.
 *
 * The live channel needs an ABI/ACE software-vendor cert + EDI enrolment, so
 * `transmit()` only calls the real endpoint when ACE_ENDPOINT + ACE_API_KEY are
 * set; otherwise it falls back to the deterministic simulator.
 */

const { CustomsConnector } = require('./baseConnector');
const { httpTransmit } = require('./transport');
const { decideOutcome, deterministicRef } = require('./simulate');
const { CHANNEL, STATUS } = require('../schema');

// ACE numeric/string status → normalized status.
const ACE_STATUS_MAP = {
    '01': STATUS.ACCEPTED,   // accepted
    ACCEPTED: STATUS.ACCEPTED,
    '07': STATUS.SUBMITTED,  // under CBP review
    REVIEW: STATUS.SUBMITTED,
    PENDING: STATUS.SUBMITTED,
    '03': STATUS.REJECTED,   // rejected
    REJECTED: STATUS.REJECTED,
};

class USConnector extends CustomsConnector {
    constructor(opts = {}) {
        super({ channel: CHANNEL.ACE, gatewayName: 'ACE', ...opts });
        this.endpoint = opts.endpoint || process.env.ACE_ENDPOINT || null;
        this.apiKey = opts.apiKey || process.env.ACE_API_KEY || null;
    }

    validateDeclaration(declaration) {
        const errors = [];
        const importer = declaration.importer;
        if (declaration.entry_type === 'import' && (!importer || !importer.tax_id)) {
            errors.push({ code: 'US_MISSING_IOR_ID', level: 'error', text: 'ACE requires an Importer of Record identifier (EIN / CBP number)' });
        }
        // ACE requires a 10-digit HTSUS classification on every line.
        declaration.line_items.forEach((l) => {
            const digits = String(l.hs_code || '').replace(/\D/g, '');
            if (digits.length < 8) {
                errors.push({ code: 'US_SHORT_HTS', level: 'error', text: `Line ${l.line_no}: ACE requires an 8–10 digit HTSUS code` });
            }
        });
        return errors;
    }

    buildPayload(declaration) {
        return {
            entryType: '01', // 01 = consumption entry
            importerOfRecord: {
                name: (declaration.importer || {}).name,
                id: (declaration.importer || {}).tax_id,
            },
            portOfEntry: (declaration.metadata && declaration.metadata.port_code) || '2704', // Los Angeles
            enteredValue: declaration.customs_value,
            currency: declaration.currency,
            lineItems: declaration.line_items.map((l) => ({
                htsNumber: String(l.hs_code || '').replace(/\D/g, ''),
                description: l.description,
                quantity: l.quantity,
                uom: l.unit,
                value: l.value,
                countryOfOrigin: l.origin_country,
            })),
        };
    }

    async transmit(payload, ctx) {
        if (this.endpoint && this.apiKey) {
            return httpTransmit(this, {
                url: this.endpoint,
                headers: { Authorization: `Bearer ${this.apiKey}` },
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
            err.raw = { entryNumber: null, statusCode: '03', disposition: outcome.code };
            throw err;
        }
        const pending = outcome.mode === 'pending';
        return {
            entryNumber: deterministicRef('ENT', declaration),
            statusCode: pending ? '07' : '01',
            disposition: pending ? 'UNDER_REVIEW' : 'ACCEPTED',
        };
    }

    parseResponse(raw) {
        const code = String((raw && raw.statusCode) || '07').toUpperCase();
        const status = ACE_STATUS_MAP[code] || STATUS.SUBMITTED;
        return this.normalize({
            status,
            accepted: status === STATUS.ACCEPTED,
            gateway_reference: (raw && raw.entryNumber) || null,
            gateway_status: code,
            messages: status === STATUS.REJECTED
                ? [{ code: (raw && raw.disposition) || 'REJECTED', level: 'error', text: `ACE: ${(raw && raw.disposition) || 'rejected'}` }]
                : [],
            retryable: false,
            raw: raw || {},
        });
    }
}

module.exports = { USConnector };
