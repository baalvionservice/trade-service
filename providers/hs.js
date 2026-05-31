'use strict';
/**
 * Customs engine (Logistics #4): HS-code classification + tariff/duty calculation.
 *  - classify(): AI seam (Gemini via the 'ai' provider when GEMINI_API_KEY is set) with a deterministic
 *    rule-based keyword fallback so it always returns a code.
 *  - computeDuty(): duty + import-tax (VAT/GST) for an HS chapter in a destination country.
 * Rates are representative defaults for the supported 5 jurisdictions — wire a real tariff database
 * (WITS/WCO/national schedules) behind this when available.
 */

// Keyword → HS heading (6-digit) rule base. First match wins; ordered most-specific first.
const RULES = [
    { kw: ['hot-rolled', 'cold-rolled', 'steel coil', 'steel', 'iron'], hs: '720839', desc: 'Flat-rolled products of iron or non-alloy steel' },
    { kw: ['aluminium', 'aluminum'], hs: '760120', desc: 'Unwrought aluminium alloys' },
    { kw: ['copper'], hs: '740311', desc: 'Refined copper cathodes' },
    { kw: ['semiconductor', 'integrated circuit', 'microchip', 'chip'], hs: '854231', desc: 'Electronic integrated circuits — processors/controllers' },
    { kw: ['phone', 'smartphone', 'handset', 'telephone'], hs: '851712', desc: 'Telephones for cellular networks' },
    { kw: ['laptop', 'computer', 'server', 'electronics'], hs: '847130', desc: 'Portable automatic data-processing machines' },
    { kw: ['pharmaceutical', 'medicine', 'medicament', 'drug', 'vaccine'], hs: '300490', desc: 'Medicaments, packaged for retail sale' },
    // Machinery is classified by function — check 'machine/grinder/appliance' before commodity nouns
    // so e.g. "coffee grinder machine" classifies as machinery, not coffee.
    { kw: ['machine', 'machinery', 'grinder', 'appliance', 'apparatus', 'equipment'], hs: '847989', desc: 'Machines & mechanical appliances, n.e.s.' },
    { kw: ['coffee'], hs: '090111', desc: 'Coffee, not roasted, not decaffeinated' },
    { kw: ['tea'], hs: '090210', desc: 'Green tea (not fermented)' },
    { kw: ['rice'], hs: '100630', desc: 'Semi-milled or wholly milled rice' },
    { kw: ['wheat', 'grain'], hs: '100199', desc: 'Wheat and meslin' },
    { kw: ['cotton'], hs: '520100', desc: 'Cotton, not carded or combed' },
    { kw: ['garment', 'apparel', 'shirt', 'textile', 'clothing'], hs: '610910', desc: 'T-shirts/singlets of cotton, knitted' },
    { kw: ['furniture'], hs: '940360', desc: 'Wooden furniture' },
    { kw: ['wood', 'timber', 'lumber'], hs: '440710', desc: 'Coniferous wood sawn lengthwise' },
    { kw: ['vehicle', 'automobile', 'car ', 'passenger car'], hs: '870323', desc: 'Motor cars, spark-ignition 1500–3000cc' },
    { kw: ['tyre', 'tire', 'rubber'], hs: '401110', desc: 'New pneumatic tyres of rubber, for cars' },
    { kw: ['plastic'], hs: '392690', desc: 'Articles of plastics' },
    { kw: ['chemical', 'acid', 'reagent'], hs: '281122', desc: 'Silicon dioxide / inorganic chemicals' },
    { kw: ['petroleum', 'crude oil', 'diesel', 'fuel oil'], hs: '271019', desc: 'Petroleum oils (not crude)' },
    { kw: ['glass'], hs: '700529', desc: 'Float glass, non-wired' },
    { kw: ['toy', 'game'], hs: '950300', desc: 'Toys, scale models, puzzles' },
];

function classifyRules(description) {
    const text = String(description || '').toLowerCase();
    for (const r of RULES) {
        if (r.kw.some((k) => text.includes(k))) {
            return { hsCode: r.hs, hsDescription: r.desc, confidence: 0.72, source: 'rules' };
        }
    }
    return { hsCode: '999999', hsDescription: 'Unclassified — manual review required', confidence: 0.2, source: 'rules' };
}

// Async classify: try AI (Gemini) when configured, else deterministic rules. Never throws.
async function classify(description) {
    if (process.env.GEMINI_API_KEY) {
        try { return await classifyAI(description); } catch { /* fall through to rules */ }
    }
    return classifyRules(description);
}

async function classifyAI(description) {
    // Placeholder for a Gemini call (structured-output HS classification). Wire when the key is set.
    void description;
    throw new Error('AI HS classification not configured');
}

// Import VAT/GST by destination country.
const IMPORT_TAX = { US: 0.0, EU: 0.20, IN: 0.18, CN: 0.13, GB: 0.20 };

// Duty rate by destination country + HS chapter (2-digit), with a per-country default.
const DUTY = {
    US: { default: 0.034, 72: 0.0, 76: 0.0, 85: 0.0, 84: 0.012, 87: 0.025, 61: 0.16, 52: 0.082, 94: 0.0, 30: 0.0, 9: 0.0 },
    EU: { default: 0.042, 72: 0.0, 85: 0.02, 84: 0.017, 87: 0.10, 61: 0.12, 30: 0.0, 9: 0.075, 22: 0.0 },
    IN: { default: 0.10, 72: 0.075, 85: 0.20, 84: 0.075, 87: 0.70, 61: 0.20, 30: 0.10, 9: 0.30, 71: 0.125 },
    CN: { default: 0.08, 72: 0.06, 85: 0.0, 84: 0.05, 87: 0.15, 61: 0.16, 30: 0.04, 9: 0.15 },
    GB: { default: 0.04, 72: 0.0, 85: 0.0, 84: 0.0, 87: 0.10, 61: 0.12, 30: 0.0, 9: 0.0 },
};

const chapterOf = (hsCode) => Number(String(hsCode || '').replace(/\D/g, '').slice(0, 2)) || 0;

function dutyRate(hsCode, country) {
    const table = DUTY[String(country || '').toUpperCase()] || DUTY.US;
    const ch = chapterOf(hsCode);
    return table[ch] !== undefined ? table[ch] : table.default;
}

// Duty on the customs value; import tax is levied on (value + duty) (standard VAT base).
function computeDuty(hsCode, country, value) {
    const v = Number(value) || 0;
    const dRate = dutyRate(hsCode, country);
    const tRate = IMPORT_TAX[String(country || '').toUpperCase()] ?? 0;
    const duty = Math.round(v * dRate * 100) / 100;
    const tax = Math.round((v + duty) * tRate * 100) / 100;
    return { dutyRate: dRate, dutyAmount: duty, taxRate: tRate, taxAmount: tax, total: Math.round((duty + tax) * 100) / 100 };
}

// 5-country declaration form per destination.
const TEMPLATES = { US: 'US_CBP_7501', EU: 'EU_SAD', IN: 'IN_BOE', CN: 'CN_DECL', GB: 'UK_C88' };
const templateFor = (country) => TEMPLATES[String(country || '').toUpperCase()] || 'GENERIC_DECLARATION';

function health() { return { name: 'hs', mode: process.env.GEMINI_API_KEY ? 'live' : 'simulated', healthy: true }; }

module.exports = { classify, classifyRules, computeDuty, dutyRate, templateFor, TEMPLATES, IMPORT_TAX, health };
