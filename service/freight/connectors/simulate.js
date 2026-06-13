'use strict';
/**
 * Deterministic carrier SIMULATION (Prompt 10).
 *
 * The real DHL / FedEx / UPS / Maersk APIs need accredited accounts, OAuth client
 * credentials and a sandbox enrolment we don't have in this environment — so each
 * connector's transmit step is wired to a REAL-HTTP seam that is dormant until its
 * endpoint env var is set, and otherwise falls back to this simulator.
 *
 * The simulator is fully DETERMINISTIC (no Math.random / Date entropy in the
 * decision) so the verify harness can assert the retry / fallback / normalization
 * paths exactly. Outcome is driven by `request.metadata.simulate` — and to make
 * per-carrier fallback testable, a carrier-scoped directive
 * `request.metadata.simulate_<carrier>` overrides the global one for THAT carrier:
 *
 *   undefined | 'accept'   → quote + book succeed
 *   'reject'               → permanent rejection (no retry; gateway falls back)
 *   'transient'            → transient failure on EVERY attempt (exhausts retries)
 *   'flaky:N'              → transient for the first N attempts, then succeed
 *
 * Pricing is ALSO deterministic: amount = base_fee + rate_per_kg × chargeable_weight
 * + fuel surcharge, with a per-lane multiplier hashed from origin+destination so
 * different lanes price differently without entropy.
 */

const { FAILURE_KIND } = require('../schema');

/** Resolve the effective simulate directive for a carrier (carrier-scoped wins). */
function directiveFor(request = {}, carrier) {
    const meta = request.metadata || {};
    const scoped = carrier ? meta[`simulate_${carrier}`] : null;
    return String(scoped || meta.simulate || 'accept').toLowerCase();
}

/**
 * Decide the simulated outcome for a transmission attempt.
 * @returns {{ ok: boolean, kind?: string, code?: string, reason?: string }}
 */
function decideOutcome(request = {}, ctx = {}) {
    const attempt = Number(ctx.attempt) || 1;
    const directive = directiveFor(request, ctx.carrier);

    if (directive === 'reject') {
        return { ok: false, kind: FAILURE_KIND.PERMANENT, code: 'CARRIER_REJECTED', reason: 'lane not served / account limit (carrier rejected)' };
    }
    if (directive === 'transient') {
        return { ok: false, kind: FAILURE_KIND.TRANSIENT, code: 'CARRIER_TIMEOUT', reason: 'carrier API temporarily unavailable' };
    }
    if (directive.startsWith('flaky')) {
        const n = Number(directive.split(':')[1]) || 1;
        if (attempt <= n) {
            return { ok: false, kind: FAILURE_KIND.TRANSIENT, code: 'CARRIER_TIMEOUT', reason: `carrier flaky (attempt ${attempt}/${n})` };
        }
        return { ok: true };
    }
    return { ok: true };
}

/** Stable 32-bit hash of a string (entropy-free). */
function hash(seed) {
    let h = 0;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
}

/** Stable reference token derived from the request (audit-friendly, no entropy). */
function deterministicRef(prefix, request = {}, carrier = '') {
    const o = (request.origin && request.origin.country) || '';
    const d = (request.destination && request.destination.country) || '';
    const seed = [carrier, request.reference || '', o, d, request.chargeable_weight_kg || 0].join('|');
    return `${prefix}${hash(seed).toString().padStart(10, '0').slice(0, 10)}`;
}

/** Per-lane price multiplier in [0.9, 1.4], deterministic from the lane. */
function laneMultiplier(request = {}) {
    const o = (request.origin && request.origin.country) || '';
    const d = (request.destination && request.destination.country) || '';
    const h = hash(`${o}>${d}`);
    return 0.9 + (h % 50) / 100; // 0.90 … 1.39
}

/**
 * Compute a deterministic simulated price for a carrier rate card.
 * @param {object} rateCard  { base_fee, rate_per_kg, fuel_pct }
 * @param {number} chargeableWeight
 * @param {object} request
 * @returns {{ amount, surcharges }}
 */
function simulatePrice(rateCard, chargeableWeight, request = {}) {
    const lane = laneMultiplier(request);
    const linehaul = (rateCard.base_fee + rateCard.rate_per_kg * chargeableWeight) * lane;
    const fuel = linehaul * (rateCard.fuel_pct || 0);
    const amount = Math.round((linehaul + fuel) * 100) / 100;
    const surcharges = [];
    if (fuel > 0) surcharges.push({ code: 'FUEL', label: 'Fuel surcharge', amount: Math.round(fuel * 100) / 100 });
    if ((request.destination && request.destination.residential) === true) {
        const res = Math.round(rateCard.base_fee * 0.15 * 100) / 100;
        surcharges.push({ code: 'RESI', label: 'Residential delivery', amount: res });
    }
    return { amount: Math.round((amount + surcharges.reduce((s, x) => s + (x.code === 'RESI' ? x.amount : 0), 0)) * 100) / 100, surcharges };
}

module.exports = { decideOutcome, deterministicRef, simulatePrice, laneMultiplier, hash };
