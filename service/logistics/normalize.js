'use strict';
/**
 * Logistics Optimization Agent — REQUEST NORMALIZER (Prompt 14).
 *
 * PURE: no DB, no I/O. Collapses the loose, caller-supplied optimization request
 * into the one canonical shape the route builder + scoring engine consume, and
 * surfaces structural validation errors BEFORE any route search runs (a malformed
 * request fails the same way everywhere — surface it once, don't fan out).
 *
 * A CANONICAL OPTIMIZATION REQUEST:
 *   {
 *     reference        — caller correlation id (optional)
 *     origin           — { country, city, hub? }   (hub overrides geocoding)
 *     destination      — { country, city, hub? }
 *     weight_kg        — chargeable weight (drives per-leg cost)
 *     volume_m3        — optional, informational
 *     ready_date       — ISO date the goods are ready (transit base)
 *     allowed_modes    — [MODE.*]  (empty = all modes eligible)
 *     constraints      — { max_cost, max_transit_days, min_reliability }  (optional)
 *     priority         — STRATEGY.* the caller leans toward (default balanced)
 *     currency
 *     metadata         — passthrough
 *   }
 */

const { VALID_MODES, VALID_STRATEGIES, STRATEGY, num } = require('./schema');

/** Trim + cap a free-text field; null on empty. */
function str(v, max = 120) {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s.slice(0, max) : null;
}

/** A valid [lat, lon] coordinate pair, or null. */
function normalizeCoords(c) {
    if (!Array.isArray(c) || c.length < 2) return null;
    const lat = Number(c[0]); const lon = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
}

/** Normalize a place descriptor ({ country, city, hub, coords }). */
function normalizePlace(p = {}) {
    const place = p && typeof p === 'object' ? p : {};
    const out = {
        country: place.country ? String(place.country).trim().toUpperCase().slice(0, 2) : null,
        city: str(place.city, 80),
        hub: place.hub ? String(place.hub).trim().toUpperCase().slice(0, 16) : null,
        postal_code: str(place.postal_code, 16),
    };
    const coords = normalizeCoords(place.coords);
    if (coords) out.coords = coords;
    return out;
}

/** Normalize the constraint envelope — undefined fields mean "no constraint". */
function normalizeConstraints(c = {}) {
    const con = c && typeof c === 'object' ? c : {};
    const out = {};
    if (con.max_cost != null) out.max_cost = num(con.max_cost);
    if (con.max_transit_days != null) out.max_transit_days = Math.max(0, Math.round(num(con.max_transit_days)));
    if (con.min_reliability != null) out.min_reliability = Math.max(0, Math.min(100, num(con.min_reliability)));
    return out;
}

/**
 * Normalize a loose optimization request into the canonical shape. Idempotent — a
 * pre-normalized request passes through unchanged.
 */
function normalizeRequest(input = {}) {
    const req = input && typeof input === 'object' ? input : {};

    const allowed = Array.isArray(req.allowed_modes)
        ? [...new Set(req.allowed_modes.map((m) => String(m).toLowerCase()).filter((m) => VALID_MODES.includes(m)))]
        : [];

    const priorityRaw = String(req.priority || req.strategy || '').toLowerCase();
    const priority = VALID_STRATEGIES.includes(priorityRaw) ? priorityRaw : STRATEGY.BALANCED;

    return {
        reference: str(req.reference, 64),
        origin: normalizePlace(req.origin),
        destination: normalizePlace(req.destination),
        weight_kg: num(req.weight_kg != null ? req.weight_kg : req.chargeable_weight_kg),
        volume_m3: num(req.volume_m3),
        ready_date: str(req.ready_date, 32),
        allowed_modes: allowed,
        constraints: normalizeConstraints(req.constraints),
        priority,
        currency: String(req.currency || 'USD').toUpperCase().slice(0, 8),
        metadata: req.metadata && typeof req.metadata === 'object' ? req.metadata : {},
    };
}

/**
 * Structural validation. Returns an array of { field, message } — empty = valid.
 * Geography (does a hub exist?) is the network layer's job; this checks SHAPE only.
 */
function baseValidationErrors(req = {}) {
    const errors = [];
    const r = req.__normalized ? req : normalizeRequest(req);

    const hasOrigin = r.origin && (r.origin.hub || r.origin.country || r.origin.coords);
    const hasDest = r.destination && (r.destination.hub || r.destination.country || r.destination.coords);
    if (!hasOrigin) errors.push({ field: 'origin', message: 'origin requires a hub, country or coordinates' });
    if (!hasDest) errors.push({ field: 'destination', message: 'destination requires a hub, country or coordinates' });

    if (hasOrigin && hasDest) {
        const sameHub = r.origin.hub && r.destination.hub && r.origin.hub === r.destination.hub;
        const sameCity = !r.origin.hub && !r.destination.hub
            && r.origin.country && r.origin.country === r.destination.country
            && r.origin.city && r.origin.city.toLowerCase() === (r.destination.city || '').toLowerCase();
        if (sameHub || sameCity) {
            errors.push({ field: 'destination', message: 'origin and destination resolve to the same point' });
        }
    }

    if (r.weight_kg <= 0) errors.push({ field: 'weight_kg', message: 'weight_kg must be greater than 0' });

    if (r.constraints.max_cost != null && r.constraints.max_cost <= 0) {
        errors.push({ field: 'constraints.max_cost', message: 'max_cost must be greater than 0' });
    }
    if (r.constraints.max_transit_days != null && r.constraints.max_transit_days <= 0) {
        errors.push({ field: 'constraints.max_transit_days', message: 'max_transit_days must be greater than 0' });
    }

    return errors;
}

module.exports = {
    normalizeRequest,
    normalizePlace,
    normalizeConstraints,
    baseValidationErrors,
};
