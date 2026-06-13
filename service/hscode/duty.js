'use strict';
/**
 * HS Code Intelligence Engine — DUTY ESTIMATION HOOKS (Prompt 7).
 *
 * PURE by default: no DB, no network. Estimates landed duty + import tax for a
 * resolved HS code, destination country and customs (CIF) value. The duty RATE
 * source is a PLUGGABLE seam (mirrors the AI provider): the default reads the
 * per-country tariff lines from the canonical HS database; a production system
 * drops in a maintained customs-rate feed with `registerRateProvider()` without
 * touching callers.
 *
 * "Estimation hooks" = (1) the pluggable rate provider, and (2) a stable
 * `estimateDuty()` contract other modules (order pricing, the dashboard readiness
 * scorer, the classification report) call to attach a landed-cost projection.
 *
 * ⚠️  Estimates only. Real duty depends on origin, trade agreements, valuation
 *     method, anti-dumping measures and exemptions not modelled here.
 */

const db = require('./hsDatabase');
const norm = require('./normalize');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ── Pluggable rate provider seam. ────────────────────────────────────────────
// A provider implements: rateFor({ hsCode, country, originCountry }) =>
//   { duty_rate:number, vat_rate:number, national_code?:string, source:string } | null
const databaseRateProvider = Object.freeze({
    name: 'database',
    rateFor({ hsCode, country }) {
        const entry = db.findByCode(hsCode);
        const iso = norm.normalizeCountry(country);
        if (!entry || !iso) return null;
        const line = db.tariffLine(entry, iso);
        if (!line) return null;
        return {
            duty_rate: Number(line.duty) || 0,
            vat_rate: Number(line.vat) || 0,
            national_code: line.national || null,
            source: 'database',
        };
    },
});

let activeRateProvider = databaseRateProvider;

function assertRateProvider(p) {
    if (!p || typeof p.rateFor !== 'function' || typeof p.name !== 'string') {
        throw new Error('registerRateProvider(): provider must be { name: string, rateFor: fn }');
    }
}
function registerRateProvider(provider) {
    assertRateProvider(provider);
    activeRateProvider = provider;
    return activeRateProvider;
}
function resetRateProvider() {
    activeRateProvider = databaseRateProvider;
    return activeRateProvider;
}
function getRateProvider() {
    return activeRateProvider;
}

/**
 * Estimate duty + import tax + total landed cost.
 *
 * Model: duty = customsValue × duty_rate%; import tax (VAT/GST) is levied on the
 * duty-inclusive value (customsValue + duty) — the common destination-tax base.
 *
 * @param {object} input
 * @param {string} input.hsCode
 * @param {string} input.country                  destination (ISO-2)
 * @param {string} [input.originCountry]          origin (ISO-2) — passed to provider
 * @param {number} [input.customsValue]           CIF/customs value (in `currency`)
 * @param {string} [input.currency]               value currency (passthrough)
 * @returns {object} duty estimate (always returns; `available:false` when no rate)
 */
function estimateDuty({ hsCode, country, originCountry = null, customsValue = null, currency = null } = {}) {
    const iso = norm.normalizeCountry(country);
    const value = customsValue == null ? null : Number(customsValue);
    const base = {
        hs_code: hsCode ? String(hsCode) : null,
        country: iso,
        origin_country: norm.normalizeCountry(originCountry),
        currency: currency || null,
        customs_value: Number.isFinite(value) ? round2(value) : null,
        provider: activeRateProvider.name,
    };

    let rate = null;
    try {
        rate = activeRateProvider.rateFor({ hsCode, country: iso, originCountry: base.origin_country });
    } catch (err) {
        return { ...base, available: false, reason: `rate provider failed: ${err.message}` };
    }
    if (!rate) {
        return { ...base, available: false, reason: iso ? `no tariff rate on record for ${iso}` : 'destination country not specified' };
    }

    const dutyRate = Number(rate.duty_rate) || 0;
    const vatRate = Number(rate.vat_rate) || 0;
    const result = {
        ...base,
        available: true,
        national_code: rate.national_code || null,
        duty_rate: dutyRate,
        vat_rate: vatRate,
        source: rate.source || activeRateProvider.name,
    };

    if (Number.isFinite(value) && value >= 0) {
        const dutyAmount = round2(value * (dutyRate / 100));
        const vatBase = value + dutyAmount;
        const vatAmount = round2(vatBase * (vatRate / 100));
        result.duty_amount = dutyAmount;
        result.tax_base = round2(vatBase);
        result.vat_amount = vatAmount;
        result.total_duties_and_taxes = round2(dutyAmount + vatAmount);
        result.total_landed_cost = round2(value + dutyAmount + vatAmount);
        result.effective_rate = value > 0 ? round2(((dutyAmount + vatAmount) / value) * 100) : 0;
    }
    return result;
}

module.exports = {
    estimateDuty,
    registerRateProvider,
    resetRateProvider,
    getRateProvider,
    databaseRateProvider,
};
