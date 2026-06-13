'use strict';
/**
 * Freight Marketplace Integration Layer — standalone verification harness (Prompt 10).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script runs
 * the PURE assertions with a tiny built-in runner: vocabulary + factories, the
 * shipment normalizer (chargeable weight), the ETA engine, the base connector + the
 * four carrier connectors (quote + book + retry + normalization), the quote
 * COMPARISON engine (ranking) and the registry. No DB, no network — connector retry
 * sleeps are stubbed so it is fully deterministic.
 *
 *   node tests/freight-marketplace.verify.js
 */
const assert = require('assert');

const schema = require('../service/freight/schema');
const norm = require('../service/freight/normalize');
const eta = require('../service/freight/eta');
const engine = require('../service/freight/quoteEngine');
const registry = require('../service/freight/connectors');
const { CarrierConnector } = require('../service/freight/connectors/baseConnector');
const { DhlConnector } = require('../service/freight/connectors/dhlConnector');
const { FedexConnector } = require('../service/freight/connectors/fedexConnector');
const { UpsConnector } = require('../service/freight/connectors/upsConnector');
const { MaerskConnector } = require('../service/freight/connectors/maerskConnector');

const noop = () => Promise.resolve();
// Fast connectors: zero-delay retry backoff so the harness is instant + deterministic.
const dhl = new DhlConnector({ sleep: noop });
const fedex = new FedexConnector({ sleep: noop });
const ups = new UpsConnector({ sleep: noop });
const maersk = new MaerskConnector({ sleep: noop });
const NOW = new Date('2026-06-15T00:00:00Z'); // a Monday — deterministic ETA base

let pass = 0; let fail = 0; const failures = [];
async function t(name, fn) {
    try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
    catch (err) { fail += 1; failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── Request fixtures (valid per carrier). ────────────────────────────────────
// A parcel/express lane (DHL/FedEx/UPS eligible). simulate overridable per carrier.
const parcelReq = (overrides = {}) => ({
    reference: 'SHP-1', mode: 'express', currency: 'USD', declared_value: 5000, ready_date: '2026-06-15',
    origin: { country: 'DE', city: 'Berlin', postal_code: '10115' },
    destination: { country: 'US', city: 'New York', postal_code: '10001' },
    pieces: [{ quantity: 2, weight_kg: 10, length_cm: 40, width_cm: 30, height_cm: 20 }],
    metadata: {}, ...overrides,
});
// An ocean lane (Maersk eligible).
const oceanReq = (overrides = {}) => ({
    reference: 'OCN-1', mode: 'ocean', currency: 'USD', declared_value: 80000, ready_date: '2026-06-15',
    origin: { country: 'CN', city: 'Shanghai', postal_code: '200000' },
    destination: { country: 'NL', city: 'Rotterdam', postal_code: '3011' },
    pieces: [{ quantity: 1, weight_kg: 12000, length_cm: 600, width_cm: 240, height_cm: 260 }],
    metadata: {}, ...overrides,
});

(async () => {
    // ── schema vocabulary ─────────────────────────────────────────────────────
    section('schema');
    await t('carriersForMode filters by capability', () => {
        assert.deepStrictEqual(schema.carriersForMode('ocean').sort(), ['maersk']);
        const exp = schema.carriersForMode('express').sort();
        assert.deepStrictEqual(exp, ['dhl', 'fedex', 'ups']);
        assert.strictEqual(schema.carriersForMode(null).length, 4);
    });
    await t('normalizedQuote factory enforces carrier + mode', () => {
        const q = schema.normalizedQuote({ carrier: schema.CARRIER.DHL, mode: schema.MODE.EXPRESS, amount: 100, transit_days: 3 });
        assert.strictEqual(q.carrier, 'dhl');
        assert.strictEqual(q.amount, 100);
        assert.throws(() => schema.normalizedQuote({ carrier: 'bogus' }));
        assert.throws(() => schema.normalizedQuote({ carrier: schema.CARRIER.DHL, mode: 'teleport' }));
    });
    await t('normalizedBooking factory enforces carrier + status', () => {
        const b = schema.normalizedBooking({ carrier: schema.CARRIER.UPS, status: schema.STATUS.BOOKED, accepted: true, tracking_number: '1Z9' });
        assert.strictEqual(b.status, 'booked');
        assert.throws(() => schema.normalizedBooking({ carrier: schema.CARRIER.UPS, status: 'nope' }));
    });
    await t('FreightError classifies retryable + fallback kinds', () => {
        assert.strictEqual(schema.freightError(schema.FAILURE_KIND.TRANSIENT, 'x').retryable, true);
        assert.strictEqual(schema.freightError(schema.FAILURE_KIND.PERMANENT, 'x').retryable, false);
        assert.strictEqual(schema.isFallbackKind(schema.FAILURE_KIND.TRANSIENT), true);
        assert.strictEqual(schema.isFallbackKind(schema.FAILURE_KIND.PERMANENT), true);
        assert.strictEqual(schema.isFallbackKind(schema.FAILURE_KIND.VALIDATION), false);
    });

    // ── normalize (chargeable weight) ─────────────────────────────────────────
    section('normalize');
    await t('normalizeShipmentRequest computes chargeable = max(actual, volumetric)', () => {
        const r = norm.normalizeShipmentRequest(parcelReq());
        // actual = 2 × 10 = 20kg; volumetric(express,5000) = 2 × (40·30·20)/5000 = 2 × 4.8 = 9.6kg
        assert.strictEqual(r.gross_weight_kg, 20);
        assert.strictEqual(r.volumetric_weight_kg, 9.6);
        assert.strictEqual(r.chargeable_weight_kg, 20); // actual wins here
    });
    await t('volumetric wins when bulky + light', () => {
        const r = norm.normalizeShipmentRequest(parcelReq({ pieces: [{ quantity: 1, weight_kg: 1, length_cm: 100, width_cm: 100, height_cm: 100 }] }));
        // volumetric(express) = 1000000/5000 = 200kg ≫ 1kg actual
        assert.strictEqual(r.chargeable_weight_kg, 200);
    });
    await t('chargeableWeightForMode re-derives per divisor', () => {
        const r = norm.normalizeShipmentRequest(parcelReq());
        const air = norm.chargeableWeightForMode(r, 'air');   // divisor 6000 → 8.0 vol; gross 20 wins
        assert.strictEqual(air, 20);
        assert.strictEqual(norm.normalizeCountry('Germany'), 'DE');
    });
    await t('baseValidationErrors flags missing essentials', () => {
        const errs = norm.baseValidationErrors(norm.normalizeShipmentRequest({ mode: 'express' }));
        const codes = errs.map((e) => e.code);
        assert.ok(codes.includes('MISSING_ORIGIN'));
        assert.ok(codes.includes('MISSING_DESTINATION'));
        assert.ok(codes.includes('NO_PIECES'));
        assert.ok(codes.includes('BAD_WEIGHT'));
    });

    // ── ETA engine ─────────────────────────────────────────────────────────────
    section('eta');
    await t('estimateEta counts business days, skips weekends', () => {
        // ready Mon 2026-06-15, transit 3 business days → Thu 2026-06-18
        const e = eta.estimateEta({ transitDays: 3, readyDate: '2026-06-15' });
        assert.strictEqual(e.estimated_pickup, '2026-06-15');
        assert.strictEqual(e.estimated_delivery, '2026-06-18');
    });
    await t('estimateEta rolls a weekend ready date to Monday + skips the weekend in transit', () => {
        // ready Sat 2026-06-20 → pickup Mon 06-22; +5 business days → Mon 06-29
        const e = eta.estimateEta({ transitDays: 5, readyDate: '2026-06-20' });
        assert.strictEqual(e.estimated_pickup, '2026-06-22');
        assert.strictEqual(e.estimated_delivery, '2026-06-29');
    });
    await t('estimateEta is deterministic + ignores entropy', () => {
        const a = eta.estimateDelivery({ transitDays: 4, readyDate: '2026-06-15' });
        const b = eta.estimateDelivery({ transitDays: 4, readyDate: '2026-06-15' });
        assert.strictEqual(a, b);
    });

    // ── base interface contract ─────────────────────────────────────────────────
    section('base interface');
    await t('CarrierConnector is abstract (cannot be instantiated)', () => {
        assert.throws(() => new CarrierConnector({ carrier: schema.CARRIER.DHL }), /abstract/);
    });
    await t('every connector extends CarrierConnector + advertises modes', () => {
        [dhl, fedex, ups, maersk].forEach((c) => assert.ok(c instanceof CarrierConnector));
        assert.ok(dhl.serves('express'));
        assert.ok(!dhl.serves('ocean'));
        assert.ok(maersk.serves('ocean'));
        assert.ok(!maersk.serves('express'));
    });

    // ── connector validation ─────────────────────────────────────────────────
    section('carrier validation');
    await t('DHL requires destination postal code', async () => {
        const r = parcelReq(); delete r.destination.postal_code;
        await assert.rejects(dhl.quote(r), (e) => e.kind === schema.FAILURE_KIND.VALIDATION && e.messages.some((m) => m.code === 'DHL_MISSING_POSTAL'));
    });
    await t('FedEx requires origin postal code', async () => {
        const r = parcelReq(); delete r.origin.postal_code;
        await assert.rejects(fedex.quote(r), (e) => e.messages.some((m) => m.code === 'FEDEX_MISSING_ORIGIN_POSTAL'));
    });
    await t('UPS requires destination city', async () => {
        const r = parcelReq(); delete r.destination.city;
        await assert.rejects(ups.quote(r), (e) => e.messages.some((m) => m.code === 'UPS_MISSING_CITY'));
    });
    await t('Maersk requires a declared value', async () => {
        const r = oceanReq(); r.declared_value = 0;
        await assert.rejects(maersk.quote(r), (e) => e.messages.some((m) => m.code === 'MAERSK_MISSING_VALUE'));
    });

    // ── quote + booking + normalization ────────────────────────────────────────
    section('quote + booking + normalization');
    await t('DHL quotes → normalized quote with ETA + reliability', async () => {
        const { quote } = await dhl.quote(parcelReq(), { now: NOW });
        assert.strictEqual(quote.carrier, 'dhl');
        assert.strictEqual(quote.mode, 'express');
        assert.ok(quote.amount > 0);
        assert.strictEqual(quote.transit_days, 3);
        assert.strictEqual(quote.reliability, 97);
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(quote.estimated_delivery));
    });
    await t('all four carriers normalize quotes to the SAME shape', async () => {
        const keys = ['carrier', 'service_level', 'mode', 'amount', 'currency', 'transit_days', 'estimated_delivery', 'valid_until', 'surcharges', 'reliability', 'chargeable_weight', 'raw'];
        for (const [c, r] of [[dhl, parcelReq()], [fedex, parcelReq()], [ups, parcelReq()], [maersk, oceanReq()]]) {
            const { quote } = await c.quote(r, { now: NOW });
            assert.deepStrictEqual(Object.keys(quote).sort(), [...keys].sort());
        }
    });
    await t('DHL books → tracking number + label + BOOKED', async () => {
        const { quote } = await dhl.quote(parcelReq(), { now: NOW });
        const { booking } = await dhl.book(parcelReq(), quote, {});
        assert.strictEqual(booking.status, 'booked');
        assert.strictEqual(booking.accepted, true);
        assert.ok(/^JD/.test(booking.tracking_number));
        assert.ok(booking.label_url);
    });
    await t('Maersk books → carrier booking ref + B/L (no parcel label)', async () => {
        const { quote } = await maersk.quote(oceanReq(), { now: NOW });
        const { booking } = await maersk.book(oceanReq(), quote, {});
        assert.strictEqual(booking.accepted, true);
        assert.ok(/^MAEU/.test(booking.tracking_number));
        assert.ok(/^BL/.test(booking.gateway_reference));
        assert.strictEqual(booking.label_url, null);
    });
    await t('all four carriers normalize bookings to the SAME shape', async () => {
        const keys = ['carrier', 'status', 'accepted', 'tracking_number', 'gateway_reference', 'label_url', 'service_level', 'mode', 'amount', 'currency', 'estimated_delivery', 'messages', 'retryable', 'received_at', 'raw'];
        for (const [c, r] of [[dhl, parcelReq()], [fedex, parcelReq()], [ups, parcelReq()], [maersk, oceanReq()]]) {
            const { quote } = await c.quote(r, { now: NOW });
            const { booking } = await c.book(r, quote, {});
            assert.deepStrictEqual(Object.keys(booking).sort(), [...keys].sort());
        }
    });

    // ── retry mechanism ─────────────────────────────────────────────────────────
    section('retry mechanism');
    await t('flaky carrier succeeds after retrying (3 attempts)', async () => {
        const attemptsSeen = [];
        const c = new DhlConnector({ sleep: noop, maxAttempts: 3, onAttempt: (a) => attemptsSeen.push(a) });
        const { quote, attempts } = await c.quote(parcelReq({ metadata: { simulate: 'flaky:2' } }), { now: NOW });
        assert.strictEqual(attempts, 3);
        assert.deepStrictEqual(attemptsSeen, [1, 2, 3]);
        assert.ok(quote.amount > 0);
    });
    await t('persistent transient failure exhausts retries then throws transient', async () => {
        const c = new FedexConnector({ sleep: noop, maxAttempts: 3 });
        let captured = null;
        try { await c.quote(parcelReq({ metadata: { simulate: 'transient' } })); } catch (e) { captured = e; }
        assert.ok(captured);
        assert.strictEqual(captured.kind, schema.FAILURE_KIND.TRANSIENT);
    });
    await t('permanent rejection is NOT retried (single attempt)', async () => {
        const attemptsSeen = [];
        const c = new UpsConnector({ sleep: noop, maxAttempts: 5, onAttempt: (a) => attemptsSeen.push(a) });
        let captured = null;
        try { await c.quote(parcelReq({ metadata: { simulate: 'reject' } })); } catch (e) { captured = e; }
        assert.ok(captured);
        assert.strictEqual(captured.kind, schema.FAILURE_KIND.PERMANENT);
        assert.deepStrictEqual(attemptsSeen, [1]);
    });
    await t('classifyTransport maps HTTP status to the right kind', () => {
        assert.strictEqual(dhl.classifyTransport(new Error('x'), { status: 503 }).kind, schema.FAILURE_KIND.TRANSIENT);
        assert.strictEqual(dhl.classifyTransport(new Error('x'), { status: 429 }).kind, schema.FAILURE_KIND.TRANSIENT);
        assert.strictEqual(dhl.classifyTransport(new Error('x'), { status: 400 }).kind, schema.FAILURE_KIND.PERMANENT);
        const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
        assert.strictEqual(dhl.classifyTransport(abort).kind, schema.FAILURE_KIND.TRANSIENT);
    });

    // ── quote comparison engine ─────────────────────────────────────────────────
    section('quote comparison engine');
    await t('compareQuotes fans out across the three eligible parcel carriers', async () => {
        const r = await engine.compareQuotes(parcelReq(), { now: NOW });
        assert.strictEqual(r.quotes.length, 3);
        assert.deepStrictEqual(r.carriers_quoted.sort(), ['dhl', 'fedex', 'ups']);
        assert.strictEqual(r.carriers_failed.length, 0);
    });
    await t('ocean request routes only to Maersk', async () => {
        const r = await engine.compareQuotes(oceanReq(), { now: NOW });
        assert.deepStrictEqual(r.carriers_quoted, ['maersk']);
    });
    await t('ranking exposes cheapest / fastest / best', async () => {
        const r = await engine.compareQuotes(parcelReq(), { now: NOW });
        const prices = r.quotes.map((q) => q.amount);
        assert.strictEqual(r.cheapest.amount, Math.min(...prices));
        const transits = r.quotes.map((q) => q.transit_days);
        assert.strictEqual(r.fastest.transit_days, Math.min(...transits));
        assert.ok(r.best); // composite winner exists
        assert.strictEqual(r.ranked.length, 3);
    });
    await t('a single carrier outage does not sink the comparison', async () => {
        // FedEx down (transient), DHL+UPS still quote.
        const r = await engine.compareQuotes(parcelReq({ metadata: { simulate_fedex: 'transient' } }), { now: NOW });
        assert.deepStrictEqual(r.carriers_quoted.sort(), ['dhl', 'ups']);
        assert.deepStrictEqual(r.carriers_failed, ['fedex']);
        assert.strictEqual(r.errors[0].kind, schema.FAILURE_KIND.TRANSIENT);
    });
    await t('a structurally invalid request fails once (not N times)', async () => {
        await assert.rejects(engine.compareQuotes({ mode: 'express' }), (e) => e.kind === schema.FAILURE_KIND.VALIDATION);
    });

    // ── registry ──────────────────────────────────────────────────────────────
    section('registry');
    await t('eligibleConnectors resolves the right carriers per mode', () => {
        const parcel = registry.eligibleConnectors(norm.normalizeShipmentRequest(parcelReq()));
        assert.deepStrictEqual(parcel.map((c) => c.carrier).sort(), ['dhl', 'fedex', 'ups']);
        const ocean = registry.eligibleConnectors(norm.normalizeShipmentRequest(oceanReq()));
        assert.deepStrictEqual(ocean.map((c) => c.carrier), ['maersk']);
    });
    await t('registry is pluggable — register + reset an override', () => {
        const fake = new DhlConnector({ carrierName: 'FAKE' });
        registry.registerConnector(schema.CARRIER.DHL, fake);
        assert.strictEqual(registry.getConnectorByCarrier(schema.CARRIER.DHL), fake);
        registry.resetConnectors();
        assert.notStrictEqual(registry.getConnectorByCarrier(schema.CARRIER.DHL), fake);
        assert.ok(registry.getConnectorByCarrier(schema.CARRIER.DHL) instanceof DhlConnector);
    });
    await t('supportedCarriers lists all four integrations', () => {
        assert.deepStrictEqual(registry.supportedCarriers().sort(), ['dhl', 'fedex', 'maersk', 'ups']);
    });

    // ── summary ─────────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`freight-marketplace.verify — ${pass} passed, ${fail} failed (${pass + fail} total)`);
    if (fail) {
        console.log('\nFailures:');
        failures.forEach((f) => console.log(`  • ${f.name}: ${f.message}`));
        process.exit(1);
    }
    process.exit(0);
})();
