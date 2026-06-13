'use strict';
/**
 * Idempotent seed for the Trade Operations Cloud (War Room 4, Prompt 1).
 * Re-running TRUNCATEs the tradeops tables and reinserts a known sample set
 * spanning TWO tenants (to demonstrate isolation) with full operation ->
 * shipment -> events/documents/status-history graphs.
 *
 *   node seedTradeOps.js
 *
 * RLS SAFETY
 * ----------
 * migration 009 puts FORCE ROW LEVEL SECURITY on every tradeops table and the
 * policy fails closed: with no `app.current_tenant` GUC set, INSERT/SELECT are
 * rejected for any role that is subject to RLS (the production `baalvion_app`
 * role, and even the table owner under FORCE). A naive seed that writes with no
 * GUC works ONLY against a superuser connection where RLS is bypassed, so it
 * would silently break the moment the runtime cuts over to baalvion_app.
 *
 * To behave identically in EVERY environment we wrap each tenant's writes in one
 * managed transaction and stamp `app.current_tenant` LOCAL to it (set_config(...,
 * is_local=true) — the exact mechanism middleware/tenantConnection.js uses at
 * runtime). We deliberately do NOT set app.tenant_bypass: the seed proves the
 * happy path through the real tenant policy rather than around it.
 */
const db = require('./models');

const now = Date.now();
const at = (offsetHours = 0) => new Date(now + offsetHours * 3600000);

// Stamp the tenant GUC LOCAL to a transaction so every write/read on it runs
// under the real RLS policy for `tenant`. Vanishes on commit (leak-proof).
async function setTenantGuc(t, tenant) {
    await db.sequelize.query(
        "SELECT set_config('app.current_tenant', :tenant, true)",
        { replacements: { tenant }, transaction: t },
    );
}

// Run fn inside a tenant-scoped transaction (GUC set, transaction passed in).
function withTenant(tenant, fn) {
    return db.sequelize.transaction(async (t) => {
        await setTenantGuc(t, tenant);
        return fn(t);
    });
}

async function seedDemoTenant() {
    // ── Tenant T-DEMO: an active sea consignment (in transit) + a draft op ───
    return withTenant('T-DEMO', async (t) => {
        const op1 = await db.TradeOperation.create({
            tenant_id: 'T-DEMO',
            reference_no: 'TO-2026-0001',
            buyer_org_id: 'COMP-101',
            seller_org_id: 'COMP-102',
            commodity: 'Copper Cathodes (Grade A)',
            hs_code: '7403.11',
            incoterm: 'CIF',
            origin_country: 'CN',
            destination_country: 'US',
            status: 'in_transit',
            priority: 'high',
            total_value: 1696000.00,
            currency: 'USD',
            expected_start_date: '2026-05-20',
            expected_completion_date: '2026-06-28',
            metadata: { contract_no: 'MSA-CU-2026-02', route: 'Shanghai → Long Beach' },
            created_by: 'seed',
        }, { transaction: t });

        const ship1 = await db.TradeShipment.create({
            tenant_id: 'T-DEMO',
            trade_operation_id: op1.id,
            shipment_no: 'SHP-2026-0001',
            carrier_id: 'CR-MAERSK',
            carrier_name: 'Maersk Line',
            mode: 'sea',
            tracking_number: 'MAEU7782341',
            vessel_name: 'Maersk Edinburgh',
            voyage_no: '614W',
            container_no: 'MSKU7782341',
            bill_of_lading_no: 'BL-MAEU-90021',
            origin_port: 'CNSHA',
            destination_port: 'USLGB',
            origin_country: 'CN',
            destination_country: 'US',
            status: 'in_transit',
            estimated_departure: at(-480),
            actual_departure: at(-468),
            estimated_arrival: at(360),
            gross_weight_kg: 24000.000,
            volume_cbm: 33.200,
            package_count: 20,
            declared_value: 1696000.00,
            currency: 'USD',
            incoterm: 'CIF',
            created_by: 'seed',
        }, { transaction: t });

        await db.ShipmentEvent.bulkCreate([
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, event_type: 'booking_confirmed', event_code: 'BKG', description: 'Booking confirmed with carrier', location_name: 'Shanghai', location_country: 'CN', occurred_at: at(-540), source: 'carrier' },
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, event_type: 'gate_in', event_code: 'GTI', description: 'Container gated in at origin terminal', location_name: 'Yangshan Terminal', location_country: 'CN', latitude: 30.616700, longitude: 122.065000, occurred_at: at(-492), source: 'carrier' },
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, event_type: 'loaded', event_code: 'LOD', description: 'Loaded on vessel Maersk Edinburgh', location_name: 'Shanghai Port', location_country: 'CN', occurred_at: at(-470), source: 'carrier' },
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, event_type: 'departed', event_code: 'DEP', description: 'Vessel departed origin port', location_name: 'Shanghai Port', location_country: 'CN', occurred_at: at(-468), source: 'carrier' },
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, event_type: 'gps_ping', event_code: 'GPS', description: 'Mid-Pacific position report', latitude: 21.300000, longitude: -157.800000, occurred_at: at(-120), source: 'iot', payload: { speed_knots: 18.4, heading: 78 } },
        ], { transaction: t });

        await db.ShipmentDocument.bulkCreate([
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, trade_operation_id: op1.id, doc_type: 'bill_of_lading', title: 'Master Bill of Lading', file_name: 'BL-MAEU-90021.pdf', mime_type: 'application/pdf', file_size_bytes: 184320, storage_provider: 'cms', storage_ref: 'cms://media/bl/90021', sha256: 'a1b2c3d4e5f6', status: 'verified', issued_at: at(-466) },
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, trade_operation_id: op1.id, doc_type: 'commercial_invoice', title: 'Commercial Invoice', file_name: 'CI-2026-0001.pdf', mime_type: 'application/pdf', file_size_bytes: 96400, storage_provider: 'cms', storage_ref: 'cms://media/ci/0001', status: 'verified', issued_at: at(-538) },
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, trade_operation_id: op1.id, doc_type: 'certificate_of_origin', title: 'Certificate of Origin', file_name: 'COO-2026-0001.pdf', mime_type: 'application/pdf', status: 'pending', issued_at: at(-460) },
        ], { transaction: t });

        await db.ShipmentStatusHistory.bulkCreate([
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, from_status: null, to_status: 'booked', reason: 'created', changed_by: 'seed', changed_at: at(-540) },
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, from_status: 'booked', to_status: 'picked_up', reason: 'gate_in', changed_by: 'seed', changed_at: at(-492) },
            { tenant_id: 'T-DEMO', shipment_id: ship1.id, from_status: 'picked_up', to_status: 'in_transit', reason: 'vessel_departed', changed_by: 'seed', changed_at: at(-468) },
        ], { transaction: t });

        // A draft air operation (no shipment yet).
        await db.TradeOperation.create({
            tenant_id: 'T-DEMO',
            reference_no: 'TO-2026-0002',
            buyer_org_id: 'COMP-101',
            seller_org_id: 'COMP-103',
            commodity: 'Lithium-ion Battery Cells',
            hs_code: '8507.60',
            incoterm: 'FCA',
            origin_country: 'KR',
            destination_country: 'DE',
            status: 'draft',
            priority: 'normal',
            total_value: 540000.00,
            currency: 'EUR',
            metadata: { note: 'Awaiting export licence' },
            created_by: 'seed',
        }, { transaction: t });
    });
}

async function seedAcmeTenant() {
    // ── Tenant T-ACME: separate consignment proving tenant isolation ─────────
    return withTenant('T-ACME', async (t) => {
        const op3 = await db.TradeOperation.create({
            tenant_id: 'T-ACME',
            reference_no: 'TO-2026-0001', // same ref no, different tenant — allowed
            buyer_org_id: 'ACME-01',
            seller_org_id: 'ACME-77',
            commodity: 'Arabica Green Coffee',
            hs_code: '0901.11',
            incoterm: 'FOB',
            origin_country: 'BR',
            destination_country: 'GB',
            status: 'active',
            priority: 'normal',
            total_value: 312000.00,
            currency: 'USD',
            created_by: 'seed',
        }, { transaction: t });

        const ship3 = await db.TradeShipment.create({
            tenant_id: 'T-ACME',
            trade_operation_id: op3.id,
            shipment_no: 'SHP-2026-0001',
            carrier_id: 'CR-HAPAG',
            carrier_name: 'Hapag-Lloyd',
            mode: 'sea',
            tracking_number: 'HLCU5521099',
            origin_port: 'BRSSZ',
            destination_port: 'GBFXT',
            origin_country: 'BR',
            destination_country: 'GB',
            status: 'booked',
            estimated_arrival: at(720),
            created_by: 'seed',
        }, { transaction: t });

        await db.ShipmentStatusHistory.create({
            tenant_id: 'T-ACME', shipment_id: ship3.id, from_status: null, to_status: 'booked', reason: 'created', changed_by: 'seed', changed_at: at(-2),
        }, { transaction: t });
    });
}

async function seed() {
    // Clean slate — TRUNCATE is a table-privilege op, not row-filtered by RLS, so
    // it does not need a tenant GUC. CASCADE removes shipments/events/documents/
    // history via FK.
    await db.sequelize.query('TRUNCATE tradeops.trade_operations CASCADE');

    await seedDemoTenant();
    await seedAcmeTenant();

    // Summary counts — read each tenant under its own GUC so the totals are
    // correct under FORCE RLS for BOTH the dev owner role and baalvion_app.
    const models = ['TradeOperation', 'TradeShipment', 'ShipmentEvent', 'ShipmentDocument', 'ShipmentStatusHistory'];
    const counts = Object.fromEntries(models.map((m) => [m, 0]));
    for (const tenant of ['T-DEMO', 'T-ACME']) {
        await withTenant(tenant, async (t) => {
            for (const m of models) {
                counts[m] += await db[m].count({ paranoid: false, transaction: t });
            }
        });
    }
    return counts;
}

seed()
    .then((counts) => { console.log('[seedTradeOps] done', counts); return db.sequelize.close(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[seedTradeOps] FAILED', e); process.exit(1); });
