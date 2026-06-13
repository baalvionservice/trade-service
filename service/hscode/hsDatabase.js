'use strict';
/**
 * HS Code Intelligence Engine — HS CODE DATABASE STRUCTURE (Prompt 7).
 *
 * The canonical, in-memory reference dataset the PURE layers (search, fallback,
 * duty, compliance) operate on. Keeping it in JS — not behind the DB — is a
 * deliberate mirror of the validation engine's offline-first design: the search
 * + suggestion + duty pipeline works with zero infrastructure and stays
 * reproducible in tests. The DB tables (migration 012) are seeded FROM this same
 * canonical source by `seedHsCodes.js`, so there is one source of truth.
 *
 * ── Harmonized System structure ──────────────────────────────────────────────
 *   chapter (2 digits) → heading (4) → subheading (6, international) → national
 *   extension (8/10, country-specific). Every entry below is keyed by its 6-digit
 *   subheading and carries per-country `tariffs` (the 8/10-digit national line +
 *   duty/VAT rates + any restrictions) — i.e. MULTI-COUNTRY HS MAPPING.
 *
 * ⚠️  DATA DISCLAIMER: this is an ILLUSTRATIVE reference set spanning common
 *     trade commodities — it is NOT an authoritative or exhaustive tariff
 *     schedule, and the duty/VAT figures are representative samples. Production
 *     duty determination must go through a maintained customs data source via the
 *     pluggable rate-provider seam in `duty.js`. Nothing here should be treated
 *     as legal/customs advice.
 */

// Supported destination/origin markets (platform's 5-country footprint).
const COUNTRIES = Object.freeze(['IN', 'US', 'GB', 'AE', 'SG']);

/**
 * Compact tariff builder. `[duty, vat, national, restrictions?]` → tariff object.
 * duty/vat are ad-valorem percentages. `restrictions` is an optional object:
 *   { license?, controlled?, prohibited?, dual_use?, permit?, inspection? }
 */
function tl(duty, vat, national, restrictions = null) {
    return restrictions
        ? { duty, vat, national, restrictions }
        : { duty, vat, national };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL ENTRIES. Each: { hs_code, heading, chapter, description, category,
//   unit, keywords[], tariffs{ISO:tariff}, controls?[] }.
//   `controls` carry product-specific compliance signals consumed by compliance.js
//   (chapter-level rules live in compliance.js itself).
// ─────────────────────────────────────────────────────────────────────────────
const ENTRIES = [
    // ── Chapter 03 — Fish & crustaceans ──────────────────────────────────────
    {
        hs_code: '030617', heading: '0306', chapter: '03', category: 'agriculture', unit: 'kg',
        description: 'Frozen shrimps and prawns',
        keywords: ['shrimp', 'shrimps', 'prawn', 'prawns', 'frozen shrimp', 'seafood', 'crustacean'],
        tariffs: { IN: tl(30, 5, '03061700'), US: tl(0, 0, '0306170040'), GB: tl(12, 0, '0306170000'), AE: tl(0, 5, '03061700'), SG: tl(0, 9, '03061700') },
        controls: [{ code: 'INSPECTION_REQUIRED', severity: 'medium', scope: 'import', requires: 'Sanitary/phytosanitary inspection', message: 'Perishable foodstuff — subject to food-safety inspection at import' }],
    },
    // ── Chapter 08/09/10 — Edible plants, coffee, cereals ────────────────────
    {
        hs_code: '080390', heading: '0803', chapter: '08', category: 'agriculture', unit: 'kg',
        description: 'Bananas, fresh or dried (excluding plantains)',
        keywords: ['banana', 'bananas', 'fresh fruit', 'dried banana'],
        tariffs: { IN: tl(30, 0, '08039010'), US: tl(0, 0, '0803901000'), GB: tl(16, 0, '0803900000'), AE: tl(0, 0, '08039000'), SG: tl(0, 9, '08039000') },
    },
    {
        hs_code: '090111', heading: '0901', chapter: '09', category: 'agriculture', unit: 'kg',
        description: 'Coffee, not roasted, not decaffeinated',
        keywords: ['coffee', 'green coffee', 'arabica', 'robusta', 'coffee beans', 'raw coffee'],
        tariffs: { IN: tl(100, 5, '09011100'), US: tl(0, 0, '0901110015'), GB: tl(0, 0, '0901110000'), AE: tl(5, 5, '09011100'), SG: tl(0, 9, '09011100') },
    },
    {
        hs_code: '100199', heading: '1001', chapter: '10', category: 'agriculture', unit: 'kg',
        description: 'Wheat and meslin (excluding seed, durum)',
        keywords: ['wheat', 'meslin', 'grain', 'cereal', 'wheat grain'],
        tariffs: { IN: tl(40, 0, '10019910'), US: tl(0.7, 0, '1001990020'), GB: tl(0, 0, '1001990000'), AE: tl(0, 0, '10019900'), SG: tl(0, 9, '10019900') },
    },
    {
        hs_code: '100630', heading: '1006', chapter: '10', category: 'agriculture', unit: 'kg',
        description: 'Semi-milled or wholly milled rice',
        keywords: ['rice', 'milled rice', 'basmati', 'white rice', 'parboiled rice'],
        tariffs: { IN: tl(70, 0, '10063010'), US: tl(1.4, 0, '1006301090'), GB: tl(16, 0, '1006300000'), AE: tl(0, 0, '10063000'), SG: tl(0, 9, '10063000') },
    },
    // ── Chapter 17/18 — Sugar & cocoa ────────────────────────────────────────
    {
        hs_code: '170199', heading: '1701', chapter: '17', category: 'agriculture', unit: 'kg',
        description: 'Refined cane or beet sugar, solid form',
        keywords: ['sugar', 'refined sugar', 'cane sugar', 'beet sugar', 'white sugar'],
        tariffs: { IN: tl(100, 5, '17019910'), US: tl(3.6, 0, '1701990510'), GB: tl(34, 0, '1701990000'), AE: tl(5, 5, '17019900'), SG: tl(0, 9, '17019900') },
    },
    {
        hs_code: '180690', heading: '1806', chapter: '18', category: 'agriculture', unit: 'kg',
        description: 'Chocolate and other cocoa food preparations',
        keywords: ['chocolate', 'cocoa', 'confectionery', 'cocoa preparation', 'chocolate bar'],
        tariffs: { IN: tl(30, 18, '18069090'), US: tl(8.5, 0, '1806900100'), GB: tl(8, 20, '1806900000'), AE: tl(5, 5, '18069000'), SG: tl(0, 9, '18069000') },
    },
    // ── Chapter 22/24 — Beverages & tobacco (excise) ─────────────────────────
    {
        hs_code: '220421', heading: '2204', chapter: '22', category: 'beverages', unit: 'l',
        description: 'Wine of fresh grapes, in containers ≤ 2 litres',
        keywords: ['wine', 'grape wine', 'red wine', 'white wine', 'alcohol', 'sparkling wine'],
        tariffs: { IN: tl(150, 28, '22042100'), US: tl(6.3, 0, '2204210000'), GB: tl(10, 20, '2204210000'), AE: tl(50, 5, '22042100', { license: 'Liquor import licence' }), SG: tl(0, 9, '22042100', { license: 'Customs liquor licence' }) },
        controls: [{ code: 'EXCISE_GOODS', severity: 'medium', scope: 'both', message: 'Alcoholic beverage — excise duty and age/licensing controls apply' }],
    },
    {
        hs_code: '240220', heading: '2402', chapter: '24', category: 'tobacco', unit: 'thousand',
        description: 'Cigarettes containing tobacco',
        keywords: ['cigarettes', 'cigarette', 'tobacco', 'smoking'],
        tariffs: { IN: tl(30, 28, '24022010', { license: 'Tobacco import authorisation' }), US: tl(1.05, 0, '2402201000'), GB: tl(57.6, 20, '2402200000'), AE: tl(100, 5, '24022090'), SG: tl(0, 9, '24022090', { license: 'Tobacco import licence' }) },
        controls: [{ code: 'EXCISE_GOODS', severity: 'high', scope: 'both', message: 'Tobacco product — high excise, plain-packaging and licensing controls apply' }],
    },
    // ── Chapter 27/28/29/31/38 — Mineral fuels & chemicals ───────────────────
    {
        hs_code: '271019', heading: '2710', chapter: '27', category: 'energy', unit: 'l',
        description: 'Petroleum oils (other than crude), incl. diesel & lubricants',
        keywords: ['petroleum', 'diesel', 'gas oil', 'lubricant', 'fuel oil', 'mineral oil'],
        tariffs: { IN: tl(2.5, 18, '27101944'), US: tl(1.5, 0, '2710192590'), GB: tl(0, 20, '2710190000'), AE: tl(5, 5, '27101900'), SG: tl(0, 9, '27101900') },
        controls: [{ code: 'IMPORT_RESTRICTED', severity: 'medium', scope: 'both', message: 'Petroleum product — energy-sector controls and excise may apply' }],
    },
    {
        hs_code: '281410', heading: '2814', chapter: '28', category: 'chemicals', unit: 'kg',
        description: 'Anhydrous ammonia',
        keywords: ['ammonia', 'anhydrous ammonia', 'nh3', 'industrial chemical'],
        tariffs: { IN: tl(5, 18, '28141000', { controlled: true }), US: tl(0, 0, '2814100000'), GB: tl(5.5, 20, '2814100000'), AE: tl(5, 5, '28141000'), SG: tl(0, 9, '28141000', { permit: 'Hazardous substance permit' }) },
        controls: [{ code: 'DUAL_USE', severity: 'high', scope: 'both', requires: 'Hazardous/precursor chemical permit', message: 'Industrial ammonia — precursor/hazardous chemical; permit & safety controls apply' }],
    },
    {
        hs_code: '290511', heading: '2905', chapter: '29', category: 'chemicals', unit: 'kg',
        description: 'Methanol (methyl alcohol)',
        keywords: ['methanol', 'methyl alcohol', 'industrial alcohol', 'solvent'],
        tariffs: { IN: tl(7.5, 18, '29051100'), US: tl(0, 0, '2905110000'), GB: tl(5.5, 20, '2905110000'), AE: tl(5, 5, '29051100'), SG: tl(0, 9, '29051100', { permit: 'Hazardous substance permit' }) },
        controls: [{ code: 'PERMIT_REQUIRED', severity: 'medium', scope: 'both', requires: 'Hazardous substance permit', message: 'Flammable industrial solvent — hazardous-substance handling permit may apply' }],
    },
    {
        hs_code: '300490', heading: '3004', chapter: '30', category: 'pharmaceuticals', unit: 'kg',
        description: 'Medicaments, in measured doses or retail packing',
        keywords: ['medicine', 'medicament', 'pharmaceutical', 'drug', 'tablets', 'medication'],
        tariffs: { IN: tl(10, 12, '30049099', { license: 'Drug import licence (CDSCO)' }), US: tl(0, 0, '3004902000'), GB: tl(0, 0, '3004900000'), AE: tl(0, 5, '30049000', { license: 'MOHAP drug registration' }), SG: tl(0, 9, '30049000', { license: 'HSA product licence' }) },
        controls: [{ code: 'LICENSE_REQUIRED', severity: 'high', scope: 'both', requires: 'Pharmaceutical/drug import licence', message: 'Finished medicament — drug regulatory licence and registration required' }],
    },
    {
        hs_code: '310210', heading: '3102', chapter: '31', category: 'chemicals', unit: 'kg',
        description: 'Urea, whether or not in aqueous solution',
        keywords: ['urea', 'fertiliser', 'fertilizer', 'nitrogen fertiliser', 'agro chemical'],
        tariffs: { IN: tl(5, 5, '31021000'), US: tl(0, 0, '3102100000'), GB: tl(6.5, 0, '3102100000'), AE: tl(0, 5, '31021000'), SG: tl(0, 9, '31021000') },
    },
    {
        hs_code: '380891', heading: '3808', chapter: '38', category: 'chemicals', unit: 'kg',
        description: 'Insecticides, put up for retail sale',
        keywords: ['insecticide', 'pesticide', 'agro chemical', 'crop protection', 'pest control'],
        tariffs: { IN: tl(10, 18, '38089199', { permit: 'CIB&RC registration' }), US: tl(5, 0, '3808915000'), GB: tl(6, 20, '3808910000'), AE: tl(5, 5, '38089100'), SG: tl(0, 9, '38089100', { permit: 'NEA hazardous substance permit' }) },
        controls: [{ code: 'PERMIT_REQUIRED', severity: 'high', scope: 'both', requires: 'Pesticide registration/permit', message: 'Pesticide/insecticide — product registration and permit required' }],
    },
    // ── Chapter 39/40 — Plastics & rubber ────────────────────────────────────
    {
        hs_code: '392690', heading: '3926', chapter: '39', category: 'plastics', unit: 'kg',
        description: 'Other articles of plastics',
        keywords: ['plastic', 'plastics', 'plastic article', 'polymer', 'plastic component'],
        tariffs: { IN: tl(10, 18, '39269099'), US: tl(5.3, 0, '3926909989'), GB: tl(6.5, 20, '3926900000'), AE: tl(5, 5, '39269000'), SG: tl(0, 9, '39269000') },
    },
    {
        hs_code: '401110', heading: '4011', chapter: '40', category: 'rubber', unit: 'u',
        description: 'New pneumatic tyres of rubber, for motor cars',
        keywords: ['tyre', 'tire', 'pneumatic tyre', 'car tyre', 'rubber tyre'],
        tariffs: { IN: tl(10, 28, '40111010'), US: tl(4, 0, '4011100010'), GB: tl(4.5, 20, '4011100000'), AE: tl(5, 5, '40111000'), SG: tl(0, 9, '40111000') },
    },
    // ── Chapter 44 — Wood ────────────────────────────────────────────────────
    {
        hs_code: '440710', heading: '4407', chapter: '44', category: 'wood', unit: 'm3',
        description: 'Coniferous wood sawn lengthwise, thickness > 6 mm',
        keywords: ['timber', 'sawn wood', 'lumber', 'coniferous wood', 'pine', 'wood plank'],
        tariffs: { IN: tl(10, 18, '44071000'), US: tl(0, 0, '4407100001'), GB: tl(0, 20, '4407100000'), AE: tl(5, 5, '44071000'), SG: tl(0, 9, '44071000') },
        controls: [{ code: 'PERMIT_REQUIRED', severity: 'medium', scope: 'import', requires: 'Phytosanitary certificate', message: 'Wood product — phytosanitary/ISPM-15 treatment controls apply' }],
    },
    // ── Chapter 52/61/64 — Textiles & footwear ───────────────────────────────
    {
        hs_code: '520100', heading: '5201', chapter: '52', category: 'textiles', unit: 'kg',
        description: 'Cotton, not carded or combed',
        keywords: ['cotton', 'raw cotton', 'cotton fibre', 'lint cotton'],
        tariffs: { IN: tl(5, 5, '52010020'), US: tl(0, 0, '5201000500'), GB: tl(0, 20, '5201000000'), AE: tl(0, 5, '52010000'), SG: tl(0, 9, '52010000') },
    },
    {
        hs_code: '610910', heading: '6109', chapter: '61', category: 'textiles', unit: 'u',
        description: 'T-shirts, singlets and vests of cotton, knitted',
        keywords: ['t-shirt', 'tshirt', 'tee', 'cotton shirt', 'apparel', 'garment', 'clothing'],
        tariffs: { IN: tl(10, 12, '61091000'), US: tl(16.5, 0, '6109100012'), GB: tl(12, 20, '6109100000'), AE: tl(5, 5, '61091000'), SG: tl(0, 9, '61091000') },
    },
    {
        hs_code: '640299', heading: '6402', chapter: '64', category: 'footwear', unit: 'pr',
        description: 'Footwear with rubber/plastic soles and uppers, other',
        keywords: ['footwear', 'shoes', 'sneakers', 'rubber shoes', 'plastic footwear'],
        tariffs: { IN: tl(35, 18, '64029990'), US: tl(6, 0, '6402993165'), GB: tl(16.9, 20, '6402990000'), AE: tl(5, 5, '64029900'), SG: tl(0, 9, '64029900') },
    },
    // ── Chapter 68/71 — Stone & precious metals ──────────────────────────────
    {
        hs_code: '680221', heading: '6802', chapter: '68', category: 'minerals', unit: 'kg',
        description: 'Marble, travertine and alabaster (worked)',
        keywords: ['marble', 'travertine', 'alabaster', 'stone', 'natural stone', 'worked stone'],
        tariffs: { IN: tl(20, 18, '68022110'), US: tl(0, 0, '6802210000'), GB: tl(0, 20, '6802210000'), AE: tl(5, 5, '68022100'), SG: tl(0, 9, '68022100') },
    },
    {
        hs_code: '711319', heading: '7113', chapter: '71', category: 'jewellery', unit: 'g',
        description: 'Articles of jewellery of precious metal',
        keywords: ['jewellery', 'jewelry', 'gold jewellery', 'precious metal', 'ornament', 'gold ring'],
        tariffs: { IN: tl(20, 3, '71131910'), US: tl(5.5, 0, '7113192100'), GB: tl(2.5, 20, '7113190000'), AE: tl(5, 5, '71131900'), SG: tl(0, 9, '71131900') },
        controls: [{ code: 'SANCTIONS_SENSITIVE', severity: 'medium', scope: 'both', message: 'High-value precious-metal goods — AML/sanctions and hallmarking checks advised' }],
    },
    // ── Chapter 72/74/76 — Base metals ───────────────────────────────────────
    {
        hs_code: '720851', heading: '7208', chapter: '72', category: 'metals', unit: 'kg',
        description: 'Flat-rolled iron/non-alloy steel, hot-rolled, thickness > 10 mm',
        keywords: ['steel', 'hot rolled steel', 'flat steel', 'iron', 'steel plate', 'hr coil'],
        tariffs: { IN: tl(15, 18, '72085110'), US: tl(0, 0, '7208510030'), GB: tl(0, 20, '7208510000'), AE: tl(5, 5, '72085100'), SG: tl(0, 9, '72085100') },
    },
    {
        hs_code: '740311', heading: '7403', chapter: '74', category: 'metals', unit: 'kg',
        description: 'Refined copper, cathodes and sections of cathodes',
        keywords: ['copper', 'copper cathode', 'cathode', 'refined copper', 'copper grade a'],
        tariffs: { IN: tl(5, 18, '74031100'), US: tl(1, 0, '7403110000'), GB: tl(0, 20, '7403110000'), AE: tl(5, 5, '74031100'), SG: tl(0, 9, '74031100') },
    },
    {
        hs_code: '760110', heading: '7601', chapter: '76', category: 'metals', unit: 'kg',
        description: 'Unwrought aluminium, not alloyed',
        keywords: ['aluminium', 'aluminum', 'unwrought aluminium', 'aluminium ingot', 'primary aluminium'],
        tariffs: { IN: tl(7.5, 18, '76011010'), US: tl(2.6, 0, '7601103000'), GB: tl(0, 20, '7601100000'), AE: tl(5, 5, '76011000'), SG: tl(0, 9, '76011000') },
    },
    // ── Chapter 84/85 — Machinery & electronics ──────────────────────────────
    {
        hs_code: '840734', heading: '8407', chapter: '84', category: 'machinery', unit: 'u',
        description: 'Spark-ignition reciprocating engines, > 1000 cc, for vehicles',
        keywords: ['engine', 'petrol engine', 'spark ignition engine', 'motor engine', 'ic engine'],
        tariffs: { IN: tl(10, 18, '84073490'), US: tl(0, 0, '8407340000'), GB: tl(2.7, 20, '8407340000'), AE: tl(5, 5, '84073400'), SG: tl(0, 9, '84073400') },
    },
    {
        hs_code: '847130', heading: '8471', chapter: '84', category: 'electronics', unit: 'u',
        description: 'Portable digital automatic data-processing machines (laptops) ≤ 10 kg',
        keywords: ['laptop', 'notebook', 'portable computer', 'computer', 'ultrabook', 'data processing machine'],
        tariffs: { IN: tl(0, 18, '84713010'), US: tl(0, 0, '8471300100'), GB: tl(0, 20, '8471300000'), AE: tl(0, 5, '84713000'), SG: tl(0, 9, '84713000') },
    },
    {
        hs_code: '851712', heading: '8517', chapter: '85', category: 'electronics', unit: 'u',
        description: 'Telephones for cellular networks (smartphones)',
        keywords: ['smartphone', 'mobile phone', 'cell phone', 'cellular phone', 'phone', 'handset'],
        tariffs: { IN: tl(20, 18, '85171290'), US: tl(0, 0, '8517130000'), GB: tl(0, 20, '8517130000'), AE: tl(0, 5, '85171300'), SG: tl(0, 9, '85171300') },
    },
    {
        hs_code: '852872', heading: '8528', chapter: '85', category: 'electronics', unit: 'u',
        description: 'Television reception apparatus, colour',
        keywords: ['television', 'tv', 'led tv', 'television set', 'smart tv', 'monitor'],
        tariffs: { IN: tl(20, 28, '85287219'), US: tl(3.9, 0, '8528724800'), GB: tl(14, 20, '8528720000'), AE: tl(5, 5, '85287200'), SG: tl(0, 9, '85287200') },
    },
    {
        hs_code: '853710', heading: '8537', chapter: '85', category: 'electronics', unit: 'u',
        description: 'Boards/panels for electric control, for voltage ≤ 1000 V',
        keywords: ['control panel', 'switchboard', 'electrical panel', 'distribution board', 'control board'],
        tariffs: { IN: tl(7.5, 18, '85371000'), US: tl(2.7, 0, '8537109170'), GB: tl(2.1, 20, '8537100000'), AE: tl(5, 5, '85371000'), SG: tl(0, 9, '85371000') },
    },
    {
        hs_code: '854430', heading: '8544', chapter: '85', category: 'electronics', unit: 'kg',
        description: 'Ignition/other wiring sets for vehicles, aircraft or ships',
        keywords: ['wiring harness', 'wire harness', 'wiring set', 'cable assembly', 'automotive wiring'],
        tariffs: { IN: tl(15, 18, '85443000'), US: tl(5, 0, '8544300000'), GB: tl(3.3, 20, '8544300000'), AE: tl(5, 5, '85443000'), SG: tl(0, 9, '85443000') },
    },
    // ── Chapter 87/88 — Vehicles & aircraft ──────────────────────────────────
    {
        hs_code: '870323', heading: '8703', chapter: '87', category: 'vehicles', unit: 'u',
        description: 'Motor cars, spark-ignition, cylinder capacity 1500–3000 cc',
        keywords: ['car', 'motor car', 'passenger vehicle', 'automobile', 'sedan', 'suv'],
        tariffs: { IN: tl(70, 28, '87032391'), US: tl(2.5, 0, '8703230090'), GB: tl(10, 20, '8703230000'), AE: tl(5, 5, '87032300'), SG: tl(0, 9, '87032300') },
    },
    {
        hs_code: '870880', heading: '8708', chapter: '87', category: 'vehicles', unit: 'kg',
        description: 'Suspension systems and parts for motor vehicles',
        keywords: ['suspension', 'shock absorber', 'auto parts', 'vehicle parts', 'car parts', 'spare parts'],
        tariffs: { IN: tl(15, 28, '87088000'), US: tl(2.5, 0, '8708805500'), GB: tl(3, 20, '8708800000'), AE: tl(5, 5, '87088000'), SG: tl(0, 9, '87088000') },
    },
    {
        hs_code: '880240', heading: '8802', chapter: '88', category: 'aerospace', unit: 'u',
        description: 'Aeroplanes and other powered aircraft, unladen weight > 15,000 kg',
        keywords: ['aircraft', 'aeroplane', 'airplane', 'jet', 'powered aircraft', 'plane'],
        tariffs: { IN: tl(3, 5, '88024000'), US: tl(0, 0, '8802400040'), GB: tl(2.7, 20, '8802400000'), AE: tl(0, 5, '88024000'), SG: tl(0, 9, '88024000') },
        controls: [{ code: 'EXPORT_CONTROLLED', severity: 'high', scope: 'export', requires: 'Strategic/export-control authorisation', message: 'Aircraft — strategic goods; export-control authorisation typically required' }],
    },
    // ── Chapter 90 — Optical/medical instruments ─────────────────────────────
    {
        hs_code: '901890', heading: '9018', chapter: '90', category: 'medical', unit: 'u',
        description: 'Instruments and appliances used in medical/surgical sciences',
        keywords: ['medical instrument', 'surgical instrument', 'medical device', 'diagnostic device', 'medical equipment'],
        tariffs: { IN: tl(7.5, 12, '90189099', { license: 'Medical device registration' }), US: tl(0, 0, '9018908000'), GB: tl(0, 0, '9018900000'), AE: tl(0, 5, '90189000', { license: 'MOHAP device registration' }), SG: tl(0, 9, '90189000', { license: 'HSA device registration' }) },
        controls: [{ code: 'LICENSE_REQUIRED', severity: 'high', scope: 'import', requires: 'Medical device registration', message: 'Medical device — regulatory registration/licence required at import' }],
    },
    // ── Chapter 93 — Arms & ammunition (prohibited/controlled) ───────────────
    {
        hs_code: '930200', heading: '9302', chapter: '93', category: 'arms', unit: 'u',
        description: 'Revolvers and pistols',
        keywords: ['pistol', 'revolver', 'firearm', 'handgun', 'weapon', 'gun'],
        tariffs: { IN: tl(10, 28, '93020000', { prohibited: true }), US: tl(4.6, 0, '9302000000', { license: 'ATF/ITAR authorisation' }), GB: tl(3.2, 20, '9302000000', { prohibited: true }), AE: tl(5, 5, '93020000', { prohibited: true }), SG: tl(0, 9, '93020000', { prohibited: true }) },
        controls: [
            { code: 'EXPORT_CONTROLLED', severity: 'critical', scope: 'both', requires: 'Arms/ITAR export authorisation', message: 'Firearm — controlled military/dual-use item; arms-control authorisation mandatory' },
            { code: 'DUAL_USE', severity: 'high', scope: 'both', message: 'Firearm classified under Chapter 93 — strategic-goods screening required' },
        ],
    },
    // ── Chapter 95 — Toys ────────────────────────────────────────────────────
    {
        hs_code: '950300', heading: '9503', chapter: '95', category: 'consumer', unit: 'u',
        description: 'Tricycles, scooters, dolls, toys and puzzles',
        keywords: ['toy', 'toys', 'doll', 'puzzle', 'kids toy', 'childrens toy', 'scooter'],
        tariffs: { IN: tl(60, 18, '95030091'), US: tl(0, 0, '9503000090'), GB: tl(0, 20, '9503000000'), AE: tl(5, 5, '95030000'), SG: tl(0, 9, '95030000') },
        controls: [{ code: 'INSPECTION_REQUIRED', severity: 'low', scope: 'import', requires: 'Toy safety conformity', message: 'Children’s product — toy-safety conformity (e.g. EN71/ASTM F963/BIS) may apply' }],
    },
];

// ── Indexes (built once at module load). ─────────────────────────────────────
const BY_CODE = new Map();          // '090111' → entry
const BY_HEADING = new Map();       // '0901' → [entries]
const BY_CHAPTER = new Map();       // '09'   → [entries]
const BY_NATIONAL = new Map();      // national code (any country) → entry

for (const entry of ENTRIES) {
    Object.freeze(entry.keywords);
    BY_CODE.set(entry.hs_code, entry);
    if (!BY_HEADING.has(entry.heading)) BY_HEADING.set(entry.heading, []);
    BY_HEADING.get(entry.heading).push(entry);
    if (!BY_CHAPTER.has(entry.chapter)) BY_CHAPTER.set(entry.chapter, []);
    BY_CHAPTER.get(entry.chapter).push(entry);
    for (const t of Object.values(entry.tariffs)) {
        if (t.national) BY_NATIONAL.set(String(t.national), entry);
    }
}

// ── Pure accessors. ──────────────────────────────────────────────────────────

/** All canonical entries (do not mutate). */
function all() {
    return ENTRIES;
}

/**
 * Resolve any code (6-digit subheading or 8/10-digit national) to its entry.
 * Falls back to the 6-digit prefix, then the 4-digit heading's first entry.
 * @param {string|number} code
 * @returns {object|null}
 */
function findByCode(code) {
    const digits = String(code == null ? '' : code).replace(/[^0-9]/g, '');
    if (!digits) return null;
    if (BY_CODE.has(digits)) return BY_CODE.get(digits);
    if (BY_NATIONAL.has(digits)) return BY_NATIONAL.get(digits);
    const six = digits.slice(0, 6);
    if (BY_CODE.has(six)) return BY_CODE.get(six);
    const four = digits.slice(0, 4);
    if (BY_HEADING.has(four)) return BY_HEADING.get(four)[0];
    return null;
}

/** Entries under a 4-digit heading. */
function findByHeading(heading) {
    return BY_HEADING.get(String(heading)) || [];
}

/** Entries under a 2-digit chapter. */
function findByChapter(chapter) {
    return BY_CHAPTER.get(String(chapter)) || [];
}

/**
 * The per-country tariff line for an entry, or null. Pass the entry OR a code.
 * @param {object|string} entryOrCode
 * @param {string} country ISO-2
 * @returns {object|null} { duty, vat, national, restrictions? }
 */
function tariffLine(entryOrCode, country) {
    const entry = typeof entryOrCode === 'string' ? findByCode(entryOrCode) : entryOrCode;
    if (!entry || !country) return null;
    return entry.tariffs[country] || null;
}

module.exports = {
    COUNTRIES,
    ENTRIES,
    all,
    findByCode,
    findByHeading,
    findByChapter,
    tariffLine,
};
