'use strict';
/**
 * Insurance premium engine (Logistics #7). Prices cargo / liability / credit / parametric cover as
 * coverage × class-rate × risk multiplier, with a deductible. Representative rates — swap in an
 * underwriting model / real carrier (Lloyd's, Allianz, Marsh) behind this seam later.
 */
const RATES = { cargo: 0.004, liability: 0.006, credit: 0.015, parametric: 0.025 }; // premium as % of cover

function computePremium({ insuranceType = 'cargo', coverageAmount = 0, riskMultiplier = 1, deductibleRate = 0.01 } = {}) {
    const t = String(insuranceType || 'cargo').toLowerCase();
    const rate = RATES[t] !== undefined ? RATES[t] : RATES.cargo;
    const cov = Number(coverageAmount) || 0;
    const rm = Number(riskMultiplier) || 1;
    const premium = Math.round(cov * rate * rm * 100) / 100;
    const deductible = Math.round(cov * (Number(deductibleRate) || 0) * 100) / 100;
    return { insuranceType: t, coverageAmount: cov, premiumRate: rate, riskMultiplier: rm, premium, deductible };
}

function health() { return { name: 'insurance', mode: 'simulated', healthy: true }; }

module.exports = { computePremium, RATES, health };
