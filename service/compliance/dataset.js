'use strict';
/**
 * Compliance & Sanctions Engine — REFERENCE DATASET (War Room 4, Prompt 8).
 *
 * PURE static data: no DB, no I/O. The SINGLE SOURCE OF TRUTH for the three
 * global reference tables. seedCompliance.js loads this into
 * tradeops.compliance_{sanctioned_parties,controlled_goods,trade_bans}, and the
 * stateless screening path reads it directly (so the engine works even before the
 * tables are seeded). The DB-backed orchestrator prefers the live tables and
 * falls back to this dataset, so the two can never silently disagree on shape.
 *
 * This is a representative, illustrative compliance dataset for a trade platform —
 * it is NOT a substitute for a licensed, continuously-updated sanctions feed
 * (OFAC SDN / EU CFSP / UN / national export-control lists). The engine is built
 * so a real feed drops in by replacing this module + reseeding.
 */

const { SEVERITY } = require('./schema');

// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED PARTIES — comprehensively embargoed countries + a few named parties.
// `party_type: 'country'` rows are the sanctioned-country list; entity/individual/
// vessel rows are the restricted-party list. Country code lives in `country`.
// ─────────────────────────────────────────────────────────────────────────────
const SANCTIONED_PARTIES = Object.freeze([
    // Comprehensively embargoed jurisdictions.
    { party_type: 'country', name: 'Iran', country: 'IR', program: 'comprehensive_embargo', list_source: 'OFAC', severity: SEVERITY.CRITICAL, aliases: ['Islamic Republic of Iran'] },
    { party_type: 'country', name: 'North Korea', country: 'KP', program: 'comprehensive_embargo', list_source: 'UN', severity: SEVERITY.CRITICAL, aliases: ['DPRK', "Democratic People's Republic of Korea"] },
    { party_type: 'country', name: 'Syria', country: 'SY', program: 'comprehensive_embargo', list_source: 'OFAC', severity: SEVERITY.CRITICAL, aliases: [] },
    { party_type: 'country', name: 'Cuba', country: 'CU', program: 'comprehensive_embargo', list_source: 'OFAC', severity: SEVERITY.HIGH, aliases: [] },
    // Sectorally / partially sanctioned jurisdictions (high, not critical).
    { party_type: 'country', name: 'Russia', country: 'RU', program: 'sectoral_sanctions', list_source: 'EU', severity: SEVERITY.HIGH, aliases: ['Russian Federation'] },
    { party_type: 'country', name: 'Belarus', country: 'BY', program: 'sectoral_sanctions', list_source: 'EU', severity: SEVERITY.HIGH, aliases: [] },
    { party_type: 'country', name: 'Venezuela', country: 'VE', program: 'targeted_sanctions', list_source: 'OFAC', severity: SEVERITY.MEDIUM, aliases: [] },
    { party_type: 'country', name: 'Myanmar', country: 'MM', program: 'targeted_sanctions', list_source: 'EU', severity: SEVERITY.MEDIUM, aliases: ['Burma'] },
    // Illustrative named restricted parties (SDN-style).
    { party_type: 'entity', name: 'Volga Trading House', country: 'RU', program: 'SDN', list_source: 'OFAC', severity: SEVERITY.CRITICAL, aliases: ['Volga Trade'] },
    { party_type: 'entity', name: 'Pyongyang Machine Works', country: 'KP', program: 'SDN', list_source: 'UN', severity: SEVERITY.CRITICAL, aliases: [] },
    { party_type: 'organization', name: 'Crimson Crescent Logistics', country: 'IR', program: 'SDN', list_source: 'OFAC', severity: SEVERITY.CRITICAL, aliases: ['Crimson Logistics'] },
    { party_type: 'individual', name: 'Ivan Petrov Sokolov', country: 'RU', program: 'SDN', list_source: 'OFAC', severity: SEVERITY.HIGH, aliases: ['I. P. Sokolov'] },
    { party_type: 'vessel', name: 'MV Night Harbour', country: 'KP', program: 'SDN', list_source: 'UN', severity: SEVERITY.HIGH, aliases: [] },
]);

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLED GOODS — restricted / dual-use / prohibited. Matched on HS prefix
// and/or keyword. `code` is the engine's stable identifier (not an HS code).
// ─────────────────────────────────────────────────────────────────────────────
const CONTROLLED_GOODS = Object.freeze([
    // ── Prohibited (no license can clear these) ──
    {
        code: 'PROH-CW', control_type: 'prohibited', category: 'chemical_weapons',
        description: 'Chemical-weapons agents and listed precursors (CWC Schedule 1)',
        hs_prefixes: ['2811', '2812', '2853'], keywords: ['sarin', 'vx nerve', 'mustard gas', 'chemical weapon', 'nerve agent'],
        regimes: ['CWC'], severity: SEVERITY.CRITICAL, license_required: false,
    },
    {
        code: 'PROH-NARC', control_type: 'prohibited', category: 'narcotics',
        description: 'Controlled narcotic drugs and psychotropic substances',
        hs_prefixes: ['1302', '2939'], keywords: ['heroin', 'cocaine', 'methamphetamine', 'fentanyl', 'narcotic'],
        regimes: ['UN-1961'], severity: SEVERITY.CRITICAL, license_required: false,
    },
    // ── Dual-use (Wassenaar / NSG / MTCR) ──
    {
        code: 'DU-NUCLEAR', control_type: 'dual_use', category: 'nuclear',
        description: 'Nuclear materials, reactors and enrichment-related equipment',
        hs_prefixes: ['2844', '8401'], keywords: ['uranium', 'plutonium', 'centrifuge', 'nuclear reactor', 'enrichment'],
        regimes: ['NSG', 'NPT'], severity: SEVERITY.CRITICAL, license_required: true,
    },
    {
        code: 'DU-MISSILE', control_type: 'dual_use', category: 'missile_technology',
        description: 'Rocket systems, UAV propulsion and missile-applicable components',
        hs_prefixes: ['9306', '8802', '8805'], keywords: ['missile', 'rocket motor', 'guidance system', 'ballistic'],
        regimes: ['MTCR'], severity: SEVERITY.CRITICAL, license_required: true,
    },
    {
        code: 'DU-ENCRYPTION', control_type: 'dual_use', category: 'cryptography',
        description: 'Information-security and strong-cryptography items (Wassenaar Cat 5p2)',
        hs_prefixes: ['8471', '8517', '8523'], keywords: ['encryption', 'cryptographic', 'cipher module', 'hsm', 'cryptography'],
        regimes: ['Wassenaar'], severity: SEVERITY.MEDIUM, license_required: true,
    },
    {
        code: 'DU-SEMICONDUCTOR', control_type: 'dual_use', category: 'advanced_computing',
        description: 'Advanced semiconductors and lithography / fabrication equipment',
        hs_prefixes: ['8541', '8542', '8486'], keywords: ['semiconductor', 'lithography', 'wafer fab', 'integrated circuit', 'gpu accelerator'],
        regimes: ['Wassenaar'], severity: SEVERITY.HIGH, license_required: true,
    },
    {
        code: 'DU-OPTICS', control_type: 'dual_use', category: 'sensors_optics',
        description: 'Night-vision, thermal-imaging and high-end optical sensors',
        hs_prefixes: ['9005', '9013', '8525'], keywords: ['night vision', 'thermal imaging', 'infrared sensor', 'image intensifier'],
        regimes: ['Wassenaar'], severity: SEVERITY.HIGH, license_required: true,
    },
    {
        code: 'DU-UAV', control_type: 'dual_use', category: 'aerospace',
        description: 'Unmanned aerial vehicles and flight-control subsystems',
        hs_prefixes: ['8806', '8807'], keywords: ['drone', 'unmanned aerial', 'uav', 'autopilot'],
        regimes: ['Wassenaar', 'MTCR'], severity: SEVERITY.MEDIUM, license_required: true,
    },
    // ── Restricted (licensable, lower sensitivity) ──
    {
        code: 'RES-FIREARMS', control_type: 'restricted', category: 'firearms',
        description: 'Firearms, ammunition and parts thereof',
        hs_prefixes: ['9301', '9302', '9303', '9304', '9305', '9306'], keywords: ['firearm', 'rifle', 'pistol', 'ammunition', 'weapon'],
        regimes: ['ATT'], severity: SEVERITY.HIGH, license_required: true,
    },
    {
        code: 'RES-CHEM', control_type: 'restricted', category: 'industrial_chemicals',
        description: 'Toxic / precursor industrial chemicals subject to export control',
        hs_prefixes: ['2902', '2903', '2904', '2905'], keywords: ['precursor chemical', 'toluene', 'acetone', 'sulphuric acid'],
        regimes: ['CWC-Sch3'], severity: SEVERITY.MEDIUM, license_required: true,
    },
    {
        code: 'RES-CULTURAL', control_type: 'restricted', category: 'cultural_property',
        description: 'Antiquities and cultural property subject to export restriction',
        hs_prefixes: ['9705', '9706'], keywords: ['antiquity', 'artefact', 'cultural property', 'archaeological'],
        regimes: ['UNESCO-1970'], severity: SEVERITY.LOW, license_required: true,
    },
]);

// ─────────────────────────────────────────────────────────────────────────────
// TRADE BANS — country-specific export/import bans + embargoes. The
// country-specific rule mapping. `jurisdiction` is the country imposing the ban
// (or GLOBAL); `counterparty_country` is the embargoed counterparty ('*' = any);
// `category` / `hs_prefixes` scope it to goods ('*' = all goods).
// ─────────────────────────────────────────────────────────────────────────────
const TRADE_BANS = Object.freeze([
    // Comprehensive embargoes — all goods, both directions, with the listed counterparties.
    { code: 'BAN-GLOBAL-KP', jurisdiction: 'GLOBAL', direction: 'both', counterparty_country: 'KP', category: '*', hs_prefixes: [], description: 'UN comprehensive embargo on North Korea — all trade prohibited', severity: SEVERITY.CRITICAL },
    { code: 'BAN-US-IR', jurisdiction: 'US', direction: 'both', counterparty_country: 'IR', category: '*', hs_prefixes: [], description: 'US comprehensive embargo on Iran — all trade prohibited', severity: SEVERITY.CRITICAL },
    { code: 'BAN-US-SY', jurisdiction: 'US', direction: 'both', counterparty_country: 'SY', category: '*', hs_prefixes: [], description: 'US comprehensive embargo on Syria', severity: SEVERITY.CRITICAL },
    { code: 'BAN-US-CU', jurisdiction: 'US', direction: 'both', counterparty_country: 'CU', category: '*', hs_prefixes: [], description: 'US embargo on Cuba', severity: SEVERITY.HIGH },
    // Sectoral export bans — scoped to goods categories.
    { code: 'BAN-EU-RU-DUALUSE', jurisdiction: 'EU', direction: 'export', counterparty_country: 'RU', category: 'dual_use', hs_prefixes: [], description: 'EU ban on export of dual-use goods to Russia', severity: SEVERITY.HIGH },
    { code: 'BAN-EU-RU-LUXURY', jurisdiction: 'EU', direction: 'export', counterparty_country: 'RU', category: 'luxury', hs_prefixes: ['7102', '7113', '8703', '9101', '9102'], description: 'EU ban on export of luxury goods to Russia', severity: SEVERITY.MEDIUM },
    { code: 'BAN-EU-BY-DUALUSE', jurisdiction: 'EU', direction: 'export', counterparty_country: 'BY', category: 'dual_use', hs_prefixes: [], description: 'EU ban on export of dual-use goods to Belarus', severity: SEVERITY.HIGH },
    { code: 'BAN-GLOBAL-ARMS-KP', jurisdiction: 'GLOBAL', direction: 'both', counterparty_country: 'KP', category: 'firearms', hs_prefixes: ['9301', '9302', '9303', '9304', '9305', '9306'], description: 'UN arms embargo on North Korea', severity: SEVERITY.CRITICAL },
]);

// ─────────────────────────────────────────────────────────────────────────────
// In-memory indexes (built once) for the stateless screening path.
// ─────────────────────────────────────────────────────────────────────────────
const sanctionedCountryIndex = new Map(); // alpha-2 → party row (country type)
for (const p of SANCTIONED_PARTIES) {
    if (p.party_type === 'country' && p.country) sanctionedCountryIndex.set(p.country.toUpperCase(), p);
}

const sanctionedNamedParties = SANCTIONED_PARTIES.filter((p) => p.party_type !== 'country');

function sanctionedParties() { return SANCTIONED_PARTIES; }
function sanctionedCountries() { return SANCTIONED_PARTIES.filter((p) => p.party_type === 'country'); }
function namedParties() { return sanctionedNamedParties; }
function controlledGoods() { return CONTROLLED_GOODS; }
function tradeBans() { return TRADE_BANS; }

/** The sanctioned-country row for an alpha-2 code (or null). */
function findSanctionedCountry(alpha2) {
    if (!alpha2) return null;
    return sanctionedCountryIndex.get(String(alpha2).toUpperCase()) || null;
}

module.exports = {
    SANCTIONED_PARTIES,
    CONTROLLED_GOODS,
    TRADE_BANS,
    sanctionedParties,
    sanctionedCountries,
    namedParties,
    controlledGoods,
    tradeBans,
    findSanctionedCountry,
};
