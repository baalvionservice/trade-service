'use strict';
/**
 * Idempotent seed for the HS Code Intelligence Engine (Prompt 7).
 *
 * Loads the canonical reference dataset from service/hscode/hsDatabase.js (the
 * single source of truth) into the global reference tables tradeops.hs_codes and
 * tradeops.hs_tariff_lines. Re-running upserts (no duplicates).
 *
 *   node seedHsCodes.js
 *
 * RLS SAFETY
 * ----------
 * Unlike the tenant-scoped tradeops tables, hs_codes and hs_tariff_lines are
 * GLOBAL reference data with NO tenant_id and NO row-level security (migration
 * 013 leaves them un-RLS'd, like the shared `carriers` registry). So this seed
 * needs no `app.current_tenant` GUC — plain upserts work for every role.
 */
const db = require('./models');
const hsDatabase = require('./service/hscode/hsDatabase');

async function seed() {
    const entries = hsDatabase.all();
    let codes = 0;
    let lines = 0;

    for (const entry of entries) {
        await db.HsCode.upsert({
            hs_code: entry.hs_code,
            heading: entry.heading,
            chapter: entry.chapter,
            description: entry.description,
            category: entry.category || null,
            unit: entry.unit || null,
            keywords: entry.keywords || [],
            controls: entry.controls || [],
            active: true,
        });
        codes += 1;

        for (const [country, t] of Object.entries(entry.tariffs)) {
            await db.HsTariffLine.upsert({
                hs_code: entry.hs_code,
                country,
                national_code: t.national || null,
                duty_rate: t.duty != null ? t.duty : 0,
                vat_rate: t.vat != null ? t.vat : 0,
                restrictions: t.restrictions || {},
            });
            lines += 1;
        }
    }

    return { codes, lines };
}

if (require.main === module) {
    seed()
        .then(({ codes, lines }) => {
            // eslint-disable-next-line no-console
            console.log(`HS Code seed complete: ${codes} codes, ${lines} tariff lines.`);
            return db.sequelize.close();
        })
        .then(() => process.exit(0))
        .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('HS Code seed failed:', err.message);
            process.exit(1);
        });
}

module.exports = { seed };
