'use strict';
/**
 * AI Document Validation Engine — deterministic RULES ENGINE (Prompt 5).
 *
 * PURE: no DB, no I/O, no clock dependence. Given a document's EXTRACTED fields
 * and the EXPECTED canonical reference (drawn from the trade operation / order /
 * a sibling source-of-truth document), it runs every field-consistency check and
 * returns an array of normalized findings (schema.js `finding`).
 *
 * The six checks the prompt asks for:
 *   1. Quantity mismatch
 *   2. Weight mismatch
 *   3. Address mismatch
 *   4. Currency mismatch
 *   5. Tax mismatch
 *   6. Missing-fields detection
 *
 * Each check is independent, tolerance-driven, and emits a finding only when the
 * data is present on BOTH sides and actually diverges — an absent field is the
 * completeness check's concern, not the mismatch checks'. Confidence reflects how
 * cleanly the values parsed: an exact numeric/string compare is high-confidence;
 * a fuzzy address compare scales with the similarity gap.
 */

const { SEVERITY, CATEGORY, CODE, finding } = require('./schema');
const norm = require('./normalize');

// Default tolerances — overridable per call via `options`.
const DEFAULTS = Object.freeze({
    quantityTolerance: 0,        // absolute units; documents should match exactly
    weightRelTolerance: 0.01,    // 1% relative (rounding / tare drift)
    weightDefaultUnit: 'kg',
    taxAbsTolerance: 0.01,       // currency minor-unit rounding
    taxRelTolerance: 0.005,      // 0.5% relative
    addressMinSimilarity: 0.6,   // below → mismatch
    addressWarnSimilarity: 0.85, // below → low-severity warning
});

// The canonical required-field set per document type. Drives check #6. Unknown
// doc types fall back to BASE_REQUIRED.
const BASE_REQUIRED = Object.freeze(['doc_type']);
const REQUIRED_FIELDS = Object.freeze({
    commercial_invoice: ['invoice_number', 'currency', 'quantity', 'unit_price', 'total_amount', 'seller', 'buyer'],
    proforma_invoice: ['invoice_number', 'currency', 'quantity', 'total_amount', 'seller', 'buyer'],
    packing_list: ['quantity', 'gross_weight', 'net_weight', 'package_count'],
    bill_of_lading: ['bl_number', 'shipper', 'consignee', 'port_of_loading', 'port_of_discharge'],
    certificate_of_origin: ['origin_country', 'exporter', 'consignee', 'commodity'],
    customs_declaration: ['hs_code', 'currency', 'total_amount', 'origin_country', 'destination_country'],
    insurance_certificate: ['policy_number', 'insured_amount', 'currency'],
});

function tolerances(options = {}) {
    return { ...DEFAULTS, ...options };
}

/** Pull a value trying several candidate keys (extraction vocab varies). */
function pick(obj, keys) {
    if (!obj) return undefined;
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
}

// ── 1. Quantity ──────────────────────────────────────────────────────────────
function checkQuantity(extracted, expected, t, out) {
    const aRaw = pick(extracted, ['quantity', 'qty', 'total_quantity']);
    const eRaw = pick(expected, ['quantity', 'qty', 'total_quantity']);
    if (norm.isBlank(aRaw) || norm.isBlank(eRaw)) return; // completeness check owns absence
    const a = norm.toNumber(aRaw);
    const e = norm.toNumber(eRaw);
    if (a === null || e === null) {
        out.push(finding({
            code: CODE.UNPARSEABLE_FIELD, category: CATEGORY.QUANTITY, severity: SEVERITY.MEDIUM,
            field: 'quantity', expected: eRaw, actual: aRaw, confidence: 70, source: 'rules',
            message: 'Quantity could not be parsed as a number on one side',
        }));
        return;
    }
    const delta = Math.abs(a - e);
    if (delta > t.quantityTolerance) {
        out.push(finding({
            code: CODE.QUANTITY_MISMATCH, category: CATEGORY.QUANTITY, severity: SEVERITY.HIGH,
            field: 'quantity', expected: e, actual: a, delta, confidence: 98, source: 'rules',
            message: `Quantity ${a} does not match expected ${e} (Δ ${delta})`,
        }));
    }
}

// ── 2. Weight ────────────────────────────────────────────────────────────────
function checkWeight(extracted, expected, t, out) {
    // Compare gross weight by default; net is checked too when both sides carry it.
    const pairs = [
        ['gross_weight', ['gross_weight', 'weight', 'gross']],
        ['net_weight', ['net_weight', 'net']],
    ];
    for (const [field, keys] of pairs) {
        const aRaw = pick(extracted, keys);
        const eRaw = pick(expected, keys);
        if (norm.isBlank(aRaw) || norm.isBlank(eRaw)) continue;
        const aUnit = pick(extracted, ['weight_unit', 'uom']);
        const eUnit = pick(expected, ['weight_unit', 'uom']);
        const a = norm.toGrams(typeof aRaw === 'object' ? aRaw : (aUnit ? { value: aRaw, unit: aUnit } : aRaw), t.weightDefaultUnit);
        const e = norm.toGrams(typeof eRaw === 'object' ? eRaw : (eUnit ? { value: eRaw, unit: eUnit } : eRaw), t.weightDefaultUnit);
        if (a === null || e === null) {
            out.push(finding({
                code: CODE.UNPARSEABLE_FIELD, category: CATEGORY.WEIGHT, severity: SEVERITY.MEDIUM,
                field, expected: eRaw, actual: aRaw, confidence: 65, source: 'rules',
                message: `${field} could not be normalized to a base unit on one side`,
            }));
            continue;
        }
        const denom = Math.max(Math.abs(e), 1);
        const rel = Math.abs(a - e) / denom;
        if (rel > t.weightRelTolerance) {
            out.push(finding({
                code: CODE.WEIGHT_MISMATCH, category: CATEGORY.WEIGHT, severity: SEVERITY.HIGH,
                field, expected: e, actual: a, delta: Math.round((a - e) * 1000) / 1000, unit: 'g',
                confidence: 95, source: 'rules',
                message: `${field} ${a}g differs from expected ${e}g by ${(rel * 100).toFixed(2)}%`,
            }));
        }
    }
}

// ── 3. Address ───────────────────────────────────────────────────────────────
function checkAddress(extracted, expected, t, out) {
    const fields = [
        ['consignee_address', ['consignee_address', 'consignee', 'ship_to', 'delivery_address']],
        ['shipper_address', ['shipper_address', 'shipper', 'ship_from', 'exporter_address']],
    ];
    for (const [field, keys] of fields) {
        const aRaw = pick(extracted, keys);
        const eRaw = pick(expected, keys);
        if (norm.isBlank(aRaw) || norm.isBlank(eRaw)) continue;
        const sim = norm.addressSimilarity(aRaw, eRaw);
        if (sim < t.addressMinSimilarity) {
            out.push(finding({
                code: CODE.ADDRESS_MISMATCH, category: CATEGORY.ADDRESS, severity: SEVERITY.HIGH,
                field, expected: eRaw, actual: aRaw, delta: Math.round((1 - sim) * 100) / 100,
                confidence: Math.round(70 + (1 - sim) * 25), source: 'rules',
                message: `${field} only ${(sim * 100).toFixed(0)}% similar to expected`,
            }));
        } else if (sim < t.addressWarnSimilarity) {
            out.push(finding({
                code: CODE.ADDRESS_MISMATCH, category: CATEGORY.ADDRESS, severity: SEVERITY.LOW,
                field, expected: eRaw, actual: aRaw, delta: Math.round((1 - sim) * 100) / 100,
                confidence: 60, source: 'rules',
                message: `${field} is a near-match (${(sim * 100).toFixed(0)}%); verify minor differences`,
            }));
        }
    }
}

// ── 4. Currency ──────────────────────────────────────────────────────────────
function checkCurrency(extracted, expected, t, out) {
    const aRaw = pick(extracted, ['currency', 'currency_code', 'ccy']);
    const eRaw = pick(expected, ['currency', 'currency_code', 'ccy']);
    if (norm.isBlank(aRaw) || norm.isBlank(eRaw)) return;
    const a = norm.toCurrency(aRaw);
    const e = norm.toCurrency(eRaw);
    if (a === null || e === null) {
        out.push(finding({
            code: CODE.UNPARSEABLE_FIELD, category: CATEGORY.CURRENCY, severity: SEVERITY.MEDIUM,
            field: 'currency', expected: eRaw, actual: aRaw, confidence: 70, source: 'rules',
            message: 'Currency code could not be resolved to ISO 4217 on one side',
        }));
        return;
    }
    if (a !== e) {
        out.push(finding({
            code: CODE.CURRENCY_MISMATCH, category: CATEGORY.CURRENCY, severity: SEVERITY.CRITICAL,
            field: 'currency', expected: e, actual: a, confidence: 99, source: 'rules',
            message: `Currency ${a} does not match expected ${e} — settlement risk`,
        }));
    }
}

// ── 5. Tax ───────────────────────────────────────────────────────────────────
// Verifies the stated tax amount against the expected one, and — when a tax rate
// and a taxable base are present — that tax actually equals base × rate.
function checkTax(extracted, expected, t, out) {
    const aRaw = pick(extracted, ['tax_amount', 'tax', 'vat_amount', 'vat', 'gst']);
    const eRaw = pick(expected, ['tax_amount', 'tax', 'vat_amount', 'vat', 'gst']);

    if (!norm.isBlank(aRaw) && !norm.isBlank(eRaw)) {
        const a = norm.toNumber(aRaw);
        const e = norm.toNumber(eRaw);
        if (a !== null && e !== null) {
            const diff = Math.abs(a - e);
            const rel = diff / Math.max(Math.abs(e), 1);
            if (diff > t.taxAbsTolerance && rel > t.taxRelTolerance) {
                out.push(finding({
                    code: CODE.TAX_MISMATCH, category: CATEGORY.TAX, severity: SEVERITY.HIGH,
                    field: 'tax_amount', expected: e, actual: a, delta: Math.round((a - e) * 100) / 100,
                    confidence: 96, source: 'rules',
                    message: `Tax amount ${a} differs from expected ${e} (Δ ${diff.toFixed(2)})`,
                }));
            }
        }
    }

    // Internal arithmetic consistency: tax == taxable_base × tax_rate.
    const rate = norm.toNumber(pick(extracted, ['tax_rate', 'vat_rate', 'gst_rate']));
    const base = norm.toNumber(pick(extracted, ['taxable_amount', 'subtotal', 'net_amount']));
    const stated = norm.toNumber(aRaw);
    if (rate !== null && base !== null && stated !== null) {
        const ratio = rate > 1 ? rate / 100 : rate; // accept 18 or 0.18
        const computed = base * ratio;
        const diff = Math.abs(computed - stated);
        const rel = diff / Math.max(Math.abs(computed), 1);
        if (diff > t.taxAbsTolerance && rel > t.taxRelTolerance) {
            out.push(finding({
                code: CODE.TAX_MISMATCH, category: CATEGORY.TAX, severity: SEVERITY.MEDIUM,
                field: 'tax_amount', expected: Math.round(computed * 100) / 100, actual: stated,
                delta: Math.round((stated - computed) * 100) / 100, confidence: 90, source: 'rules',
                message: `Stated tax ${stated} ≠ base ${base} × rate ${(ratio * 100).toFixed(2)}% = ${computed.toFixed(2)}`,
            }));
        }
    }
}

// ── 6. Missing-fields detection ──────────────────────────────────────────────
function checkCompleteness(docType, extracted, out) {
    const required = [...BASE_REQUIRED, ...(REQUIRED_FIELDS[docType] || [])];
    for (const field of required) {
        if (field === 'doc_type') continue; // structural, validated elsewhere
        if (norm.isBlank(pick(extracted, [field]))) {
            out.push(finding({
                code: CODE.MISSING_FIELD, category: CATEGORY.COMPLETENESS, severity: SEVERITY.MEDIUM,
                field, expected: 'present', actual: null, confidence: 100, source: 'rules',
                message: `Required field '${field}' is missing for ${docType || 'document'}`,
            }));
        }
    }
}

/**
 * Run the full rules engine.
 *
 * @param {object} input
 * @param {object} input.extracted  Fields read off the document being validated.
 * @param {object} [input.expected] Canonical reference values to validate against.
 * @param {string} [input.docType]  Document type (drives the required-field set).
 * @param {object} [input.options]  Tolerance overrides.
 * @returns {{ findings: object[] }}
 */
function run({ extracted = {}, expected = {}, docType = null, options = {} } = {}) {
    const t = tolerances(options);
    const out = [];

    checkCompleteness(docType, extracted, out);
    checkQuantity(extracted, expected, t, out);
    checkWeight(extracted, expected, t, out);
    checkAddress(extracted, expected, t, out);
    checkCurrency(extracted, expected, t, out);
    checkTax(extracted, expected, t, out);

    return { findings: out };
}

module.exports = {
    run,
    DEFAULTS,
    REQUIRED_FIELDS,
    // exported for unit tests
    checkQuantity,
    checkWeight,
    checkAddress,
    checkCurrency,
    checkTax,
    checkCompleteness,
};
