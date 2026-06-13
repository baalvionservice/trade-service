'use strict';
/**
 * Freight Marketplace Integration Layer — PURE shipment-request normalizers (Prompt 10).
 *
 * No DB, no I/O. Collapses the many shapes a freight rate/booking request arrives in
 * (an order, a typed shipment row, a raw API body) into ONE canonical shipment
 * request the carrier connectors can reason about. Each connector then projects this
 * canonical form into its own carrier-specific rate/booking message — so the
 * carrier-specific mapping lives in the connector, and the carrier-agnostic cleanup
 * (units, chargeable weight, address shape, validation) lives here.
 *
 * CHARGEABLE WEIGHT is the crux of freight pricing: carriers bill on the GREATER of
 * actual gross weight and volumetric (dimensional) weight. Volumetric weight =
 * Σ(L×W×H in cm) / divisor. Express/air use a 5000 divisor; ocean/road are billed by
 * actual/volume differently but we keep one canonical chargeable-weight figure and
 * let each connector re-interpret it for its mode.
 */

const { MODE, VALID_MODES, num } = require('./schema');

const ISO2 = /^[A-Za-z]{2}$/;

// Dimensional divisors (cm³ per kg) by mode — the industry-standard volumetric factors.
const DIM_DIVISOR = Object.freeze({
    [MODE.EXPRESS]: 5000,
    [MODE.AIR]: 6000,
    [MODE.ROAD]: 3000,
    [MODE.OCEAN]: 1000, // 1 CBM ≈ 1000 kg revenue-ton equivalence
});

/** Normalize a country to ISO-3166 alpha-2 upper-case (null when unusable). */
function normalizeCountry(country) {
    if (!country) return null;
    const c = String(country).trim().toUpperCase();
    if (ISO2.test(c)) return c;
    const MAP = {
        INDIA: 'IN', IND: 'IN',
        USA: 'US', 'UNITED STATES': 'US', US: 'US',
        UAE: 'AE', 'UNITED ARAB EMIRATES': 'AE', ARE: 'AE',
        GERMANY: 'DE', DEU: 'DE', FRANCE: 'FR', FRA: 'FR',
        NETHERLANDS: 'NL', NLD: 'NL', SPAIN: 'ES', ESP: 'ES', ITALY: 'IT', ITA: 'IT',
        CHINA: 'CN', CHN: 'CN', 'UNITED KINGDOM': 'GB', GBR: 'GB', UK: 'GB',
        SINGAPORE: 'SG', SGP: 'SG',
    };
    return MAP[c] || (c.length === 2 ? c : null);
}

/** Trim a string to a bounded length (null when empty). */
const str = (v, max = 256) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** Normalize a single endpoint (origin / destination). */
function normalizeAddress(addr = {}) {
    if (!addr || typeof addr !== 'object') return null;
    const country = normalizeCountry(addr.country || addr.country_code);
    const city = str(addr.city, 120);
    const postal = str(addr.postal_code || addr.postalCode || addr.zip, 32);
    if (!country && !city && !postal) return null;
    return {
        country,
        city,
        postal_code: postal,
        line1: str(addr.line1 || addr.address || addr.street, 256),
        residential: addr.residential === true,
    };
}

/**
 * Normalize a single package/piece. Dimensions in cm, weight in kg.
 * @returns {{ quantity, weight_kg, length_cm, width_cm, height_cm }}
 */
function normalizePiece(piece = {}) {
    const quantity = Math.max(1, Math.round(num(piece.quantity != null ? piece.quantity : 1)));
    return {
        quantity,
        weight_kg: num(piece.weight_kg != null ? piece.weight_kg : piece.weight),
        length_cm: num(piece.length_cm != null ? piece.length_cm : piece.length),
        width_cm: num(piece.width_cm != null ? piece.width_cm : piece.width),
        height_cm: num(piece.height_cm != null ? piece.height_cm : piece.height),
    };
}

/** Volumetric weight (kg) for a piece set under a given mode's divisor. */
function volumetricWeight(pieces, mode) {
    const divisor = DIM_DIVISOR[mode] || DIM_DIVISOR[MODE.EXPRESS];
    return pieces.reduce((sum, p) => {
        const vol = p.length_cm * p.width_cm * p.height_cm; // cm³ per piece
        return sum + (vol / divisor) * p.quantity;
    }, 0);
}

/** Actual gross weight (kg) for a piece set. */
function actualWeight(pieces) {
    return pieces.reduce((sum, p) => sum + p.weight_kg * p.quantity, 0);
}

/**
 * Build the canonical shipment request from a loose input. Accepts an order, a typed
 * shipment, or a raw request body. Never throws — fields default empty so validation
 * (not normalization) reports the gaps.
 * @returns {object} canonical shipment request
 */
function normalizeShipmentRequest(input = {}) {
    const rawMode = String(input.mode || '').toLowerCase();
    const mode = VALID_MODES.includes(rawMode) ? rawMode : null; // null ⇒ "any eligible carrier"

    const pieceInput = Array.isArray(input.pieces || input.packages)
        ? (input.pieces || input.packages)
        : [];
    const pieces = pieceInput.map(normalizePiece);

    // Chargeable weight is mode-dependent (divisor differs). When no mode is given we
    // compute against EXPRESS (the strictest divisor) as the canonical figure; each
    // connector re-derives chargeable weight for ITS mode in buildQuoteRequest.
    const dimMode = mode || MODE.EXPRESS;
    const actual = actualWeight(pieces);
    const volumetric = volumetricWeight(pieces, dimMode);
    // Allow callers to pass an explicit total weight (e.g. ocean where dims unknown).
    const explicitWeight = num(input.total_weight_kg != null ? input.total_weight_kg : input.weight_kg);
    const grossWeight = Math.max(actual, explicitWeight);
    const chargeableWeight = Math.max(grossWeight, volumetric);

    return {
        reference: str(input.reference || input.shipment_reference, 64),
        mode,
        incoterm: str(input.incoterm, 8),
        currency: (str(input.currency, 8) || 'USD').toUpperCase(),
        declared_value: num(input.declared_value != null ? input.declared_value : input.value),
        origin: normalizeAddress(input.origin || input.from),
        destination: normalizeAddress(input.destination || input.to),
        pieces,
        gross_weight_kg: Number(grossWeight.toFixed(3)),
        volumetric_weight_kg: Number(volumetric.toFixed(3)),
        chargeable_weight_kg: Number(chargeableWeight.toFixed(3)),
        ready_date: str(input.ready_date || input.readyDate, 40),
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    };
}

/** Re-derive chargeable weight for a SPECIFIC mode (a connector picks its own divisor). */
function chargeableWeightForMode(request, mode) {
    const volumetric = volumetricWeight(request.pieces || [], mode);
    return Number(Math.max(request.gross_weight_kg || 0, volumetric).toFixed(3));
}

/**
 * Shared, carrier-agnostic completeness checks. Each connector ADDS its own rules
 * (a lane it doesn't serve, a weight cap) on top, but every carrier needs at least
 * these. Returns an array of normalized validation messages ({ code, level, text });
 * an empty array means "structurally complete".
 */
function baseValidationErrors(request = {}) {
    const errors = [];
    const push = (code, text) => errors.push({ code, level: 'error', text });

    if (!request.origin || !request.origin.country) push('MISSING_ORIGIN', 'Origin country is required');
    if (!request.destination || !request.destination.country) push('MISSING_DESTINATION', 'Destination country is required');
    if (!Array.isArray(request.pieces) || request.pieces.length === 0) {
        push('NO_PIECES', 'At least one package/piece is required');
    }
    if (!(num(request.chargeable_weight_kg) > 0)) {
        push('BAD_WEIGHT', 'Chargeable weight must be > 0 (provide piece weights or dimensions)');
    }
    if (request.mode && !VALID_MODES.includes(request.mode)) {
        push('BAD_MODE', `Unknown transport mode '${request.mode}'`);
    }
    return errors;
}

module.exports = {
    DIM_DIVISOR,
    normalizeCountry,
    normalizeAddress,
    normalizePiece,
    volumetricWeight,
    actualWeight,
    normalizeShipmentRequest,
    chargeableWeightForMode,
    baseValidationErrors,
    str,
};
