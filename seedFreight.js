'use strict';
/**
 * Idempotent seed for the Freight Booking module (typed `trade.carriers`). Run: `node seedFreight.js`.
 * Carriers are the global logistics marketplace + the rate inputs for the quote engine
 * (controller/freightController.js). Upsert by id so re-running refreshes without duplicating.
 */
const db = require('./models');

const CARRIERS = [
    {
        id: 'CARR-MAERSK', name: 'Maersk Line', rating: 4.9,
        regions: ['Asia', 'Europe', 'North America', 'Africa'],
        avg_delivery_time: '22 days', starting_price: 1200, logo: 'M',
        description: 'World leader in integrated container logistics — ocean freight at global scale.',
        specializations: ['Ocean Freight', 'Customs Brokerage', 'Cold Chain'],
        modes: ['sea'], base_fee: 800, rate_per_kg: 0.45, transit_days: 22, reliability: 96,
    },
    {
        id: 'CARR-MSC', name: 'MSC Mediterranean Shipping', rating: 4.6,
        regions: ['Asia', 'Europe', 'South America'],
        avg_delivery_time: '25 days', starting_price: 1050, logo: 'MSC',
        description: 'The world’s largest container shipping line by capacity.',
        specializations: ['Ocean Freight', 'Reefer', 'Project Cargo'],
        modes: ['sea'], base_fee: 700, rate_per_kg: 0.40, transit_days: 25, reliability: 92,
    },
    {
        id: 'CARR-DHL', name: 'DHL Global Forwarding', rating: 4.8,
        regions: ['Asia', 'Europe', 'North America', 'Middle East'],
        avg_delivery_time: '5 days', starting_price: 2400, logo: 'DHL',
        description: 'Air & road freight forwarding with end-to-end express capability.',
        specializations: ['Air Freight', 'Express', 'Pharma'],
        modes: ['air', 'road'], base_fee: 1500, rate_per_kg: 3.20, transit_days: 5, reliability: 97,
    },
    {
        id: 'CARR-KUEHNE', name: 'Kuehne + Nagel', rating: 4.7,
        regions: ['Asia', 'Europe', 'North America', 'Oceania'],
        avg_delivery_time: '14 days', starting_price: 1600, logo: 'KN',
        description: 'Global sea, air and road logistics with strong contract-logistics depth.',
        specializations: ['Sea Freight', 'Air Freight', 'Contract Logistics'],
        modes: ['sea', 'air', 'road'], base_fee: 1100, rate_per_kg: 1.10, transit_days: 14, reliability: 94,
    },
    {
        id: 'CARR-DBSCHENKER', name: 'DB Schenker', rating: 4.5,
        regions: ['Europe', 'Asia'],
        avg_delivery_time: '10 days', starting_price: 900, logo: 'DB',
        description: 'European road & rail network with intercontinental forwarding.',
        specializations: ['Road Freight', 'Rail Freight', 'Land Transport'],
        modes: ['road', 'rail'], base_fee: 600, rate_per_kg: 0.90, transit_days: 10, reliability: 90,
    },
    {
        id: 'CARR-FEDEX', name: 'FedEx Freight', rating: 4.7,
        regions: ['North America', 'Europe', 'Asia'],
        avg_delivery_time: '4 days', starting_price: 2600, logo: 'FX',
        description: 'Time-definite air freight and LTL across major trade lanes.',
        specializations: ['Air Freight', 'LTL', 'Express'],
        modes: ['air'], base_fee: 1800, rate_per_kg: 3.80, transit_days: 4, reliability: 96,
    },
];

(async () => {
    try {
        await db.sequelize.authenticate();
        await db.sequelize.sync({ alter: false }); // ensure carriers/freight_quotes tables exist
        for (const c of CARRIERS) {
            await db.Carrier.upsert({ ...c, active: true });
        }
        const count = await db.Carrier.count();
        console.log(`[seedFreight] upserted ${CARRIERS.length} carriers; total in registry: ${count}`);
        process.exit(0);
    } catch (err) {
        console.error('[seedFreight] failed:', err.message);
        process.exit(1);
    }
})();
