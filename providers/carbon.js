'use strict';
/**
 * Carbon emissions engine (Logistics #6, P2). Estimates well-to-wheel CO2e for a freight leg using a
 * GLEC-aligned tonne-km × modal-emission-factor method, and prices a voluntary offset. Factors are
 * representative defaults (g CO2e per tonne-km); swap in a certified dataset (GLEC/EcoTransIT) later.
 */
const FACTORS = { sea: 12, rail: 28, road: 80, air: 540 }; // g CO2e / tonne-km
const DEFAULT_DISTANCE = { sea: 12000, rail: 5000, road: 1500, air: 9000 }; // km — rough lane defaults
const OFFSET_PRICE_PER_TONNE = Number(process.env.CARBON_OFFSET_PRICE_USD || 22); // USD per tonne CO2e

function computeEmissions({ mode = 'sea', weightKg = 0, distanceKm } = {}) {
    const m = String(mode || 'sea').toLowerCase();
    const factor = FACTORS[m] !== undefined ? FACTORS[m] : FACTORS.sea;
    const dist = Number(distanceKm) || DEFAULT_DISTANCE[m] || 5000;
    const tonnes = (Number(weightKg) || 0) / 1000;
    const co2Kg = Math.round((tonnes * dist * factor / 1000) * 100) / 100; // grams→kg
    const co2Tonnes = Math.round((co2Kg / 1000) * 1000) / 1000;
    const offsetCostUsd = Math.round(co2Tonnes * OFFSET_PRICE_PER_TONNE * 100) / 100;
    return {
        mode: m, emissionFactor: factor, distanceKm: dist, weightKg: Number(weightKg) || 0, weightTonnes: tonnes,
        co2Kg, co2Tonnes, offsetCostUsd, offsetPricePerTonne: OFFSET_PRICE_PER_TONNE,
        methodology: 'GLEC-aligned: tonne-km × modal emission factor',
    };
}

function health() { return { name: 'carbon', mode: 'simulated', healthy: true }; }

module.exports = { computeEmissions, FACTORS, DEFAULT_DISTANCE, OFFSET_PRICE_PER_TONNE, health };
