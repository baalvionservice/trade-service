'use strict';
/**
 * Customs Gateway Abstraction Layer — PURE declaration normalizers (Prompt 9).
 *
 * No DB, no I/O. Collapses the many shapes a customs declaration arrives in
 * (a legacy `trade.customs_entries` row, an HS-classified line set, a raw API
 * body) into ONE canonical declaration the connectors can reason about. Each
 * connector then projects this canonical form into its own gateway-specific
 * message — so the country-specific mapping lives in the connector, and the
 * country-agnostic cleanup lives here.
 */

const ISO2 = /^[A-Za-z]{2}$/;

/** Normalize a country to ISO-3166 alpha-2 upper-case (null when unusable). */
function normalizeCountry(country) {
    if (!country) return null;
    const c = String(country).trim().toUpperCase();
    if (ISO2.test(c)) return c;
    // A few common long-form / alpha-3 inputs the rest of the stack emits.
    const MAP = {
        INDIA: 'IN', IND: 'IN',
        USA: 'US', 'UNITED STATES': 'US', US: 'US', USoA: 'US',
        UAE: 'AE', 'UNITED ARAB EMIRATES': 'AE', ARE: 'AE',
        GERMANY: 'DE', DEU: 'DE', FRANCE: 'FR', FRA: 'FR',
        NETHERLANDS: 'NL', NLD: 'NL', SPAIN: 'ES', ESP: 'ES', ITALY: 'IT', ITA: 'IT',
    };
    return MAP[c] || (c.length === 2 ? c : null);
}

/** Trim a string to a bounded length (gateways reject overlong fields). */
const str = (v, max = 256) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** Coerce to a non-negative finite number (0 on garbage). */
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Normalize a single party (importer / exporter / declarant). */
function normalizeParty(party = {}) {
    if (!party || typeof party !== 'object') return null;
    const name = str(party.name || party.legal_name || party.company);
    if (!name && !party.tax_id && !party.eori) return null;
    return {
        name,
        tax_id: str(party.tax_id || party.gstin || party.ein || party.trn, 64),
        eori: str(party.eori, 32),                 // EU economic operator id
        iec: str(party.iec, 32),                   // India Import-Export Code
        country: normalizeCountry(party.country),
        address: str(party.address, 512),
    };
}

/** Normalize a single declaration line item. */
function normalizeLineItem(item = {}, index = 0) {
    const quantity = num(item.quantity != null ? item.quantity : item.qty);
    const unitValue = num(item.unit_value != null ? item.unit_value : item.unitPrice);
    const lineValue = item.value != null ? num(item.value) : quantity * unitValue;
    return {
        line_no: index + 1,
        hs_code: str(item.hs_code || item.hsCode, 16),
        description: str(item.description || item.product, 512),
        quantity,
        unit: str(item.unit || item.uom, 16) || 'EA',
        origin_country: normalizeCountry(item.origin_country || item.country_of_origin),
        unit_value: unitValue,
        value: lineValue,
    };
}

/**
 * Build the canonical declaration from a loose input. Accepts a legacy customs
 * entry, an HS-classified bundle, or a raw request body.
 * @returns {object} canonical declaration (never throws — fields default empty)
 */
function normalizeDeclaration(input = {}) {
    const lineItems = Array.isArray(input.line_items || input.lineItems)
        ? (input.line_items || input.lineItems)
        : [];
    const lines = lineItems.map(normalizeLineItem);
    const declaredValue = input.customs_value != null
        ? num(input.customs_value)
        : lines.reduce((sum, l) => sum + l.value, 0);

    return {
        reference: str(input.reference || input.filing_reference, 64),
        entry_type: ['import', 'export'].includes(input.entry_type) ? input.entry_type : 'import',
        origin_country: normalizeCountry(input.origin_country),
        destination_country: normalizeCountry(input.destination_country),
        incoterm: str(input.incoterm, 8),
        currency: str(input.currency, 8) || 'USD',
        customs_value: declaredValue,
        declarant: normalizeParty(input.declarant),
        importer: normalizeParty(input.importer),
        exporter: normalizeParty(input.exporter),
        line_items: lines,
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    };
}

/**
 * Shared, country-agnostic completeness checks. Each connector ADDS its own
 * jurisdiction rules on top (EORI for EU, IEC for India, …) but every gateway
 * needs at least these. Returns an array of normalized validation messages
 * ({ code, level, text }); an empty array means "structurally complete".
 */
function baseValidationErrors(declaration = {}) {
    const errors = [];
    const push = (code, text) => errors.push({ code, level: 'error', text });

    if (!declaration.destination_country) push('MISSING_DESTINATION', 'Destination country is required');
    if (!declaration.origin_country) push('MISSING_ORIGIN', 'Origin country is required');
    if (!Array.isArray(declaration.line_items) || declaration.line_items.length === 0) {
        push('NO_LINE_ITEMS', 'At least one declaration line item is required');
    } else {
        declaration.line_items.forEach((l) => {
            if (!l.hs_code) push('LINE_MISSING_HS', `Line ${l.line_no}: HS code is required`);
            if (!(l.quantity > 0)) push('LINE_BAD_QUANTITY', `Line ${l.line_no}: quantity must be > 0`);
        });
    }
    if (!(num(declaration.customs_value) > 0)) push('BAD_CUSTOMS_VALUE', 'Customs value must be > 0');
    if (!declaration.importer && declaration.entry_type === 'import') {
        push('MISSING_IMPORTER', 'Importer details are required for an import declaration');
    }
    if (!declaration.exporter && declaration.entry_type === 'export') {
        push('MISSING_EXPORTER', 'Exporter details are required for an export declaration');
    }
    return errors;
}

module.exports = {
    normalizeCountry,
    normalizeParty,
    normalizeLineItem,
    normalizeDeclaration,
    baseValidationErrors,
    str,
    num,
};
