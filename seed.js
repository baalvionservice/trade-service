'use strict';
// Idempotent reference + demo seed. Re-running clears each managed collection
// and reinserts a known set, so the long-tail pages render populated data.
// Run with: node seed.js
const db = require('./models');

const now = Date.now();
const iso = (offsetDays = 0) => new Date(now + offsetDays * 86400000).toISOString();

const ORGS = [
    { code: 'COMP-101', tenant_id: 'T-DEMO', name: 'Apex Renewable Industries', type: 'buyer', country: 'United States', status: 'active', kyc_status: 'verified', risk_score: 12.5, contact_email: 'ops@apex.demo' },
    { code: 'COMP-102', tenant_id: 'T-DEMO', name: 'Global Power Systems', type: 'seller', country: 'China', status: 'active', kyc_status: 'verified', risk_score: 8.0, contact_email: 'sales@gps.demo' },
];

// Generic-store collections (frontend reads these via res.data||[] arrays).
const COLLECTIONS = {
    wallets: [
        { companyId: 'COMP-101', currency: 'USD', balance: 2500000, escrow: 0 },
        { companyId: 'COMP-101', currency: 'EUR', balance: 480000, escrow: 0 },
        { companyId: 'COMP-102', currency: 'USD', balance: 1840000, escrow: 0 },
    ],
    alerts: [
        { type: 'CUSTOMS_HOLD', message: 'Container MSKU7782341 held at Rotterdam pending documentation review.', status: 'active', category: 'LOGISTICS', severity: 'high' },
        { type: 'WEATHER_DELAY', message: 'Typhoon advisory on the Shanghai–Long Beach corridor; +36h ETA risk.', status: 'active', category: 'LOGISTICS', severity: 'medium' },
        { type: 'SLA_BREACH', message: 'Carrier acknowledgement SLA exceeded on booking BKG-4471.', status: 'active', category: 'LOGISTICS', severity: 'medium' },
    ],
    ledger_entries: [
        { companyId: 'COMP-101', type: 'debit', amount: 1696000, currency: 'USD', referenceType: 'escrow', referenceId: '1', description: 'Escrow funding for Order 1', hash: '0x9f2a1c' },
        { companyId: 'COMP-101', type: 'credit', amount: 250000, currency: 'USD', referenceType: 'deposit', referenceId: 'TOPUP-9001', description: 'Treasury top-up (wire)', hash: '0x4b7e02' },
        { companyId: 'COMP-102', type: 'credit', amount: 1696000, currency: 'USD', referenceType: 'order', referenceId: '1', description: 'Settlement received for Order 1', hash: '0x77d3aa' },
    ],
    approvals: [
        { referenceType: 'kyc', referenceId: 'COMP-103', status: 'pending', requestedBy: 'SYSTEM_IDENTITY', requiredRole: 'Compliance Admin', reason: 'Institutional KYC verification for node COMP-103.' },
        { referenceType: 'deal', referenceId: '2', status: 'pending', requestedBy: 'COMP-101', requiredRole: 'Executive Director', reason: 'High-value deal authorization (>$1M) requires two-key sign-off.' },
        { referenceType: 'payment', referenceId: 'ESC-1', status: 'approved', requestedBy: 'COMP-101', requiredRole: 'Treasury Officer', reason: 'Escrow release authorization for delivered Order 1.', decidedBy: 'ARBITER-001', decidedAt: iso(-1) },
    ],
    contracts: [
        { companyId: 'COMP-101', title: 'Master Supply Agreement — Copper Cathodes', buyerId: 'COMP-101', sellerId: 'COMP-102', parties: 'Apex Renewable Industries / Global Power Systems', value: 1696000, currency: 'USD', status: 'EXECUTED', version: 2, clauses: [], effectiveDate: iso(-30), expiryDate: iso(335) },
        { companyId: 'COMP-101', title: 'Framework Agreement — Solar PV Modules', buyerId: 'COMP-101', sellerId: 'COMP-102', parties: 'Apex / GPS', value: 840000, currency: 'USD', status: 'LEGAL_REVIEW', version: 1, clauses: [] },
    ],
    policies: [
        { companyId: 'COMP-101', orderId: '1', shipmentId: '1', coverage: 'marine_cargo', insuredAmount: 1696000, premium: 8480, currency: 'USD', status: 'active', underwriterId: 'BAALVION_RE_01', validFrom: iso(-10), validUntil: iso(80) },
        { companyId: 'COMP-101', orderId: '2', coverage: 'trade_credit', insuredAmount: 840000, premium: 5200, currency: 'USD', status: 'underwriting', underwriterId: 'BAALVION_RE_01' },
    ],
    claims: [
        { policyId: 'P-1', shipmentId: '1', reason: 'Cargo damage', description: 'Water ingress detected on 12 pallets during transit inspection.', claimedAmount: 120000, currency: 'USD', status: 'under_review', evidenceRefs: [] },
    ],
    risk_signals: [
        { orgId: 'COMP-102', isResolved: false, type: 'VELOCITY_ANOMALY', severity: 'medium', description: 'Order velocity 3.2x above 90-day baseline.' },
        { orgId: 'COMP-101', isResolved: false, type: 'GEO_MISMATCH', severity: 'low', description: 'Billing/shipping jurisdiction mismatch flagged for review.' },
    ],
    sanctions_signals: [
        { entityId: 'COMP-880', entityName: 'Restricted Holdings LLC', type: 'OFAC', severity: 'critical', matchConfidence: 0.94, description: 'Strong name match against OFAC SDN list.', isResolved: false, timestamp: iso(-2) },
        { entityId: 'COMP-902', entityName: 'Meridian Freight Co', type: 'EU', severity: 'medium', matchConfidence: 0.61, description: 'Partial match against EU consolidated list; manual review.', isResolved: false, timestamp: iso(-1) },
    ],
    ports: [
        { name: 'Port of Shanghai', country: 'China', code: 'CNSHA', region: 'East Asia', type: 'Sea' },
        { name: 'Port of Rotterdam', country: 'Netherlands', code: 'NLRTM', region: 'Europe', type: 'Sea' },
        { name: 'Port of Long Beach', country: 'United States', code: 'USLGB', region: 'North America', type: 'Sea' },
        { name: 'Port of Singapore', country: 'Singapore', code: 'SGSIN', region: 'Southeast Asia', type: 'Sea' },
    ],
    sea_routes: [
        { name: 'Trans-Pacific East', originNode: 'CNSHA', destinationNode: 'USLGB', status: 'active', avgTransitDays: 16, currentCongestionLevel: 38 },
        { name: 'Asia–Europe Main', originNode: 'CNSHA', destinationNode: 'NLRTM', status: 'active', avgTransitDays: 31, currentCongestionLevel: 54 },
        { name: 'Red Sea Reroute', originNode: 'SGSIN', destinationNode: 'NLRTM', status: 'rerouted', avgTransitDays: 42, currentCongestionLevel: 72 },
    ],
    incoterms: [
        { code: 'EXW', name: 'Ex Works', responsibility: 'Buyer bears all costs from seller premises', riskTransfer: 'At seller premises' },
        { code: 'FOB', name: 'Free On Board', responsibility: 'Seller to vessel; buyer thereafter', riskTransfer: 'On board vessel' },
        { code: 'CIF', name: 'Cost, Insurance & Freight', responsibility: 'Seller pays freight + insurance to port', riskTransfer: 'On board vessel' },
        { code: 'DDP', name: 'Delivered Duty Paid', responsibility: 'Seller bears all costs incl. duties', riskTransfer: 'At buyer destination' },
    ],
    trade_signals: [
        { type: 'PRICE_MOVEMENT', severity: 'medium', message: 'Copper spot +4.2% w/w on LME supply tightening.', source: 'LME', commodity: 'Copper' },
        { type: 'DEMAND_SURGE', severity: 'low', message: 'Vietnam electronics sourcing demand up 18% MoM.', source: 'Baalvion Index', commodity: 'Electronics' },
        { type: 'CORRIDOR_RISK', severity: 'high', message: 'Red Sea diversions adding ~11 days to Asia–EU lanes.', source: 'Logistics Pulse', commodity: 'General' },
    ],
    risk_zones: [
        { name: 'Gulf of Aden', type: 'piracy', severity: 'high', description: 'Elevated piracy + drone activity; convoy advisories active.', affectedCorridorIds: ['Red Sea Reroute'], active: true },
        { name: 'Taiwan Strait', type: 'geopolitical', severity: 'medium', description: 'Heightened geopolitical tension; monitor insurance surcharges.', affectedCorridorIds: ['Trans-Pacific East'], active: true },
    ],
    sla_monitors: [
        { entityId: '1', entityType: 'shipment', status: 'active', deadline: iso(2), escalationRole: 'Logistics Lead', breached: false, commitmentType: 'clearance', expectedLatency: '48h' },
        { entityId: '1', entityType: 'escrow', status: 'active', deadline: iso(1), escalationRole: 'Treasury Officer', breached: false, commitmentType: 'settlement', expectedLatency: '24h' },
    ],
    regulatory_rules: [
        { country: 'China', countryId: 'China', category: 'Export', ruleType: 'Mandate', description: 'CCC certification required for listed electronics exports.', enforcedBy: 'GACC' },
        { country: 'United States', countryId: 'United States', category: 'Import', ruleType: 'Tariff', description: 'Section 301 tariffs apply to specified HS headings.', enforcedBy: 'CBP' },
        { country: 'Germany', countryId: 'Germany', category: 'Security', ruleType: 'Restriction', description: 'Dual-use export licence required under EU Reg 2021/821.', enforcedBy: 'BAFA' },
    ],
    field_tasks: [
        { entityId: '1', type: 'seal_verification', title: 'Verify container seal at Shanghai terminal', status: 'pending', location: 'Shanghai', checklist: [{ id: 'c1', label: 'Photograph seal', completed: false }, { id: 'c2', label: 'Confirm seal number', completed: false }] },
        { entityId: '1', type: 'inspection', title: 'Pre-load cargo inspection', status: 'pending', location: 'Shanghai', checklist: [{ id: 'c1', label: 'Count pallets', completed: false }] },
    ],
    sourcing_campaigns: [
        { companyId: 'COMP-101', title: 'Q3 Solar Module Procurement', targetCategory: 'Energy & Solar', status: 'active', matchesFound: 14, potentialValue: 4200000 },
        { companyId: 'COMP-101', title: 'Industrial Metals Framework', targetCategory: 'Industrial & Metals', status: 'active', matchesFound: 8, potentialValue: 2600000 },
    ],
    payouts: [
        { companyId: 'COMP-102', amount: 1696000, currency: 'USD', destination: 'HSBC •••• 4821', status: 'completed', createdAt: iso(-1) },
        { companyId: 'COMP-102', amount: 320000, currency: 'USD', destination: 'HSBC •••• 4821', status: 'pending', createdAt: iso(0) },
    ],
    settlements: [
        { escrowId: '1', sellerId: 'COMP-102', amount: 1696000, currency: 'USD', status: 'settled', settledAt: iso(-1) },
    ],
    integrations: [
        { companyId: 'COMP-101', name: 'SAP S/4HANA', type: 'ERP', status: 'active', config: {} },
        { companyId: 'COMP-101', name: 'Maersk API', type: 'CARRIER', status: 'active', config: {} },
    ],
    webhooks: [
        { companyId: 'COMP-101', eventType: 'ORDER_CONFIRMED', targetUrl: 'https://hooks.apex.demo/orders', status: 'active', createdAt: iso(-3) },
        { companyId: 'COMP-101', eventType: 'SHIPMENT_DELIVERED', targetUrl: 'https://hooks.apex.demo/logistics', status: 'active', createdAt: iso(-3) },
    ],
    verification_requests: [
        { companyId: 'COMP-103', documentType: 'Certificate of Incorporation', fileName: 'comp103_incorp.pdf', status: 'pending', uploadedAt: iso(-1) },
    ],
    customs_entries: [
        { shipmentId: '1', orderId: '1', htsCode: '7403.11', description: 'Refined copper cathodes', originCountry: 'China', destinationCountry: 'Germany', declaredValue: 1696000, currency: 'USD', dutiesCalculated: 0, taxesCalculated: 322240, status: 'in_review' },
    ],
    iot_devices: [
        { associatedEntityId: '1', name: 'Tactical Multisensor Alpha', type: 'multisensor', status: 'active', batteryLevel: 94, lastSignal: iso(0) },
    ],
};

(async () => {
    try {
        await db.sequelize.authenticate();

        for (const o of ORGS) {
            const [row, created] = await db.Organization.findOrCreate({ where: { code: o.code }, defaults: o });
            if (!created) await row.update(o);
            console.log(`org ${o.code} ${created ? 'created' : 'updated'} -> id ${row.id}`);
        }

        for (const [collection, docs] of Object.entries(COLLECTIONS)) {
            await db.Collection.destroy({ where: { collection } });
            await db.Collection.bulkCreate(docs.map((data) => ({ collection, data })));
            console.log(`collection ${collection}: seeded ${docs.length}`);
        }

        console.log('SEED DONE');
        process.exit(0);
    } catch (e) {
        console.error('SEED ERROR', e.message);
        process.exit(1);
    }
})();
