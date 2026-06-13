'use strict';
/**
 * Idempotent seed for the Compliance & Sanctions Engine (Prompt 8).
 *
 * Loads the canonical reference dataset from service/compliance/dataset.js (the
 * single source of truth) into the three GLOBAL reference tables:
 *   • tradeops.compliance_sanctioned_parties
 *   • tradeops.compliance_controlled_goods
 *   • tradeops.compliance_trade_bans
 * Re-running upserts (no duplicates).
 *
 *   node seedCompliance.js
 *
 * RLS SAFETY
 * ----------
 * Like hs_codes / carriers, these three tables are GLOBAL reference data with NO
 * tenant_id and NO row-level security (migration 014 leaves them un-RLS'd). So
 * this seed needs no `app.current_tenant` GUC — plain upserts work for every role.
 * The tenant-scoped tables (compliance_list_entries / compliance_screenings) are
 * NOT seeded here — they are per-tenant runtime data.
 */
const db = require('./models');
const dataset = require('./service/compliance/dataset');

async function seed() {
    let parties = 0;
    let goods = 0;
    let bans = 0;

    for (const p of dataset.sanctionedParties()) {
        await db.SanctionedParty.upsert({
            party_type: p.party_type,
            name: p.name,
            country: p.country || null,
            aliases: p.aliases || [],
            program: p.program || null,
            list_source: p.list_source || 'platform',
            severity: p.severity || 'high',
            notes: p.notes || null,
            metadata: p.metadata || {},
            active: true,
        });
        parties += 1;
    }

    for (const g of dataset.controlledGoods()) {
        await db.ControlledGood.upsert({
            code: g.code,
            control_type: g.control_type,
            category: g.category,
            description: g.description,
            hs_prefixes: g.hs_prefixes || [],
            keywords: g.keywords || [],
            regimes: g.regimes || [],
            severity: g.severity || 'high',
            license_required: g.license_required !== false,
            active: true,
        });
        goods += 1;
    }

    for (const b of dataset.tradeBans()) {
        await db.TradeBan.upsert({
            code: b.code,
            jurisdiction: b.jurisdiction || 'GLOBAL',
            direction: b.direction || 'both',
            counterparty_country: b.counterparty_country || '*',
            category: b.category || '*',
            hs_prefixes: b.hs_prefixes || [],
            description: b.description,
            severity: b.severity || 'critical',
            active: true,
        });
        bans += 1;
    }

    return { parties, goods, bans };
}

if (require.main === module) {
    seed()
        .then(({ parties, goods, bans }) => {
            // eslint-disable-next-line no-console
            console.log(`Compliance seed complete: ${parties} sanctioned parties, ${goods} controlled goods, ${bans} trade bans.`);
            return db.sequelize.close();
        })
        .then(() => process.exit(0))
        .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('Compliance seed failed:', err.message);
            process.exit(1);
        });
}

module.exports = { seed };
