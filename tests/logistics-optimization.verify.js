'use strict';
/**
 * Logistics Optimization Agent — standalone verification harness (Prompt 14).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script runs
 * the PURE assertions with a tiny built-in runner: vocabulary + factories, the request
 * normalizer + validation, the lane network + geo-resolution, carrier selection + leg
 * pricing, candidate route enumeration, the scoring engine (cheapest/fastest/balanced),
 * the fallback rules (synthetic route + constraint relaxation), the API integration
 * layer (provider registry + retry + classification) and the full optimizer. No DB, no
 * network — fully deterministic.
 *
 *   node tests/logistics-optimization.verify.js
 */
const assert = require('assert');

const schema = require('../service/logistics/schema');
const normalize = require('../service/logistics/normalize');
const net = require('../service/logistics/network');
const rates = require('../service/logistics/carrierRates');
const routeBuilder = require('../service/logistics/routeBuilder');
const scoring = require('../service/logistics/scoring');
const fallback = require('../service/logistics/fallbackRules');
const api = require('../service/logistics/apiIntegration');
const optimizer = require('../service/logistics/optimizer');

let pass = 0; let fail = 0; const failures = [];
async function t(name, fn) {
    try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
    catch (err) { fail += 1; failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── Request fixtures ─────────────────────────────────────────────────────────
const cnToNl = (overrides = {}) => ({
    reference: 'OPT-1', weight_kg: 5000, currency: 'USD', ready_date: '2026-06-15',
    origin: { country: 'CN', city: 'Shanghai' },
    destination: { country: 'NL', city: 'Rotterdam' },
    ...overrides,
});

(async () => {
    // ── schema ────────────────────────────────────────────────────────────────
    section('schema (vocabulary + factories)');
    await t('STRATEGY has cheapest/fastest/balanced', () => {
        assert.deepStrictEqual([...schema.VALID_STRATEGIES].sort(), ['balanced', 'cheapest', 'fastest']);
    });
    await t('normalizedLeg enforces from/to + valid mode + freezes', () => {
        const leg = schema.normalizedLeg({ from: 'CNSHA', to: 'NLRTM', mode: 'ocean', cost: 1234.567, transit_days: 32.4, reliability: 93 });
        assert.strictEqual(leg.from, 'CNSHA');
        assert.strictEqual(leg.cost, 1234.57);
        assert.strictEqual(leg.transit_days, 32);
        assert.ok(Object.isFrozen(leg));
        assert.throws(() => schema.normalizedLeg({ from: 'A', to: 'B', mode: 'teleport' }), /unknown mode/);
        assert.throws(() => schema.normalizedLeg({ to: 'B', mode: 'ocean' }), /from \+ to/);
    });
    await t('normalizedRoute aggregates cost/transit/distance + compounds reliability', () => {
        const r = schema.normalizedRoute([
            { from: 'CNSHA', to: 'SGSIN', mode: 'ocean', cost: 1000, transit_days: 8, distance_km: 4500, reliability: 90 },
            { from: 'SGSIN', to: 'NLRTM', mode: 'ocean', cost: 1500, transit_days: 24, distance_km: 15300, reliability: 90 },
        ]);
        assert.strictEqual(r.total_cost, 2500);
        assert.strictEqual(r.hops, 2);
        assert.strictEqual(r.transfers, 1);
        // 8 + 24 + 1 transfer dwell day = 33
        assert.strictEqual(r.total_transit_days, 33);
        assert.deepStrictEqual([...r.path], ['CNSHA', 'SGSIN', 'NLRTM']);
        // reliability = 0.9 * 0.9 = 0.81 → 81
        assert.strictEqual(r.reliability, 81);
    });

    // ── normalize ───────────────────────────────────────────────────────────────
    section('normalize (request + validation)');
    await t('normalizeRequest canonicalizes country + filters modes', () => {
        const r = normalize.normalizeRequest({ origin: { country: 'cn', city: 'Shanghai' }, destination: { country: 'nl' }, weight_kg: '5000', allowed_modes: ['ocean', 'teleport', 'air'] });
        assert.strictEqual(r.origin.country, 'CN');
        assert.strictEqual(r.weight_kg, 5000);
        assert.deepStrictEqual(r.allowed_modes.sort(), ['air', 'ocean']);
        assert.strictEqual(r.priority, 'balanced');
    });
    await t('validation flags missing origin + zero weight + same point', () => {
        assert.strictEqual(normalize.baseValidationErrors(cnToNl()).length, 0);
        assert.ok(normalize.baseValidationErrors({ destination: { country: 'NL' }, weight_kg: 10 }).some((e) => e.field === 'origin'));
        assert.ok(normalize.baseValidationErrors(cnToNl({ weight_kg: 0 })).some((e) => e.field === 'weight_kg'));
        assert.ok(normalize.baseValidationErrors({ origin: { hub: 'CNSHA' }, destination: { hub: 'CNSHA' }, weight_kg: 10 }).some((e) => e.field === 'destination'));
    });

    // ── network ─────────────────────────────────────────────────────────────────
    section('network (lanes + geo-resolution)');
    await t('resolveHub: explicit > city alias > country gateway', () => {
        assert.strictEqual(net.resolveHub({ hub: 'CNSHA' }).hub, 'CNSHA');
        assert.strictEqual(net.resolveHub({ city: 'Rotterdam' }).hub, 'NLRTM');
        assert.strictEqual(net.resolveHub({ country: 'AE' }).hub, 'AEJEA');
        assert.strictEqual(net.resolveHub({ country: 'ZZ' }).hub, null);
    });
    await t('lanesFrom returns symmetric built-in lanes + honors mode filter', () => {
        const all = net.lanesFrom('CNSHA');
        assert.ok(all.length > 0);
        assert.ok(all.every((l) => l.from === 'CNSHA'));
        const oceanOnly = net.lanesFrom('CNSHA', { allowedModes: ['ocean'] });
        assert.ok(oceanOnly.every((l) => l.mode === 'ocean'));
        // symmetric: there is a reverse lane back into CNSHA
        assert.ok(net.lanesFrom('NLRTM').some((l) => l.to === 'CNSHA'));
    });
    await t('haversine Shanghai→Rotterdam is a plausible great-circle distance', () => {
        const d = net.haversineKm(net.HUBS.CNSHA.coords, net.HUBS.NLRTM.coords);
        assert.ok(d > 8000 && d < 11000, `got ${d}`);
    });

    // ── carrier selection ────────────────────────────────────────────────────────
    section('carrierRates (selection + pricing)');
    await t('carriersForMode filters by capability', () => {
        assert.ok(rates.carriersForMode('ocean').includes('CARR-MAERSK'));
        assert.ok(!rates.carriersForMode('ocean').includes('CARR-DHL'));
        assert.ok(rates.carriersForMode('air').includes('CARR-DHL'));
    });
    await t('priceLane prices every eligible carrier; cheapest selection is the min', () => {
        const lane = { from: 'CNSHA', to: 'NLRTM', mode: 'ocean', distance_km: 19500, transit_days: 32, cost_rate: 0.88 };
        const opts = rates.priceLane(lane, 5000);
        assert.ok(opts.length >= 2);
        assert.ok(opts.every((o) => o.cost > 0));
        const cheapest = rates.selectCarrierForLane(lane, 5000, 'cheapest');
        assert.strictEqual(cheapest.cost, Math.min(...opts.map((o) => o.cost)));
    });

    // ── route building ────────────────────────────────────────────────────────────
    section('routeBuilder (enumeration)');
    await t('buildRoutes finds direct + multi-hop routes CNSHA→NLRTM', () => {
        const { routes } = routeBuilder.buildRoutes('CNSHA', 'NLRTM', 5000, { maxTransfers: 2 });
        assert.ok(routes.length >= 2, `got ${routes.length}`);
        // a direct ocean route exists
        assert.ok(routes.some((r) => r.hops === 1 && r.modes.includes('ocean')));
        // every route starts at CNSHA and ends at NLRTM
        assert.ok(routes.every((r) => r.path[0] === 'CNSHA' && r.path[r.path.length - 1] === 'NLRTM'));
    });
    await t('mode fan-out surfaces both an ocean (cheap/slow) and an air (dear/fast) realization', () => {
        const { routes } = routeBuilder.buildRoutes('CNSHA', 'NLRTM', 5000, { maxTransfers: 1 });
        assert.ok(routes.some((r) => r.modes.includes('ocean')));
        assert.ok(routes.some((r) => r.modes.includes('air')));
    });
    await t('unknown hub throws NO_ROUTE', () => {
        assert.throws(() => routeBuilder.buildRoutes('ZZZZZ', 'NLRTM', 5000), /unknown origin hub/);
    });

    // ── scoring ────────────────────────────────────────────────────────────────────
    section('scoring (cost-vs-speed analysis)');
    await t('rank produces distinct cheapest / fastest picks + balanced score', () => {
        const { routes } = routeBuilder.buildRoutes('CNSHA', 'NLRTM', 5000, { maxTransfers: 2 });
        const ranked = scoring.rank(routes, { strategy: 'balanced' });
        assert.ok(ranked.cheapest && ranked.fastest && ranked.balanced);
        // cheapest really is the global min cost; fastest the global min transit
        const minCost = Math.min(...routes.map((r) => r.total_cost));
        const minTransit = Math.min(...routes.map((r) => r.total_transit_days));
        assert.strictEqual(ranked.cheapest.total_cost, minCost);
        assert.strictEqual(ranked.fastest.total_transit_days, minTransit);
        // every scored route carries a breakdown
        assert.ok(ranked.routes.every((r) => r.score != null && r.score_breakdown));
        // balanced is the lowest composite score
        assert.strictEqual(ranked.balanced.score, Math.min(...ranked.routes.map((r) => r.score)));
    });
    await t('cheapest is cheaper-or-equal and fastest is faster-or-equal vs balanced', () => {
        const { routes } = routeBuilder.buildRoutes('CNSHA', 'USNYC', 8000, { maxTransfers: 2 });
        const r = scoring.rank(routes, {});
        assert.ok(r.cheapest.total_cost <= r.balanced.total_cost);
        assert.ok(r.fastest.total_transit_days <= r.balanced.total_transit_days);
    });

    // ── fallback ──────────────────────────────────────────────────────────────────
    section('fallbackRules');
    await t('syntheticRoute estimates a direct leg between hubs', () => {
        const r = fallback.syntheticRoute('CNSHA', 'NLRTM', 5000, {});
        assert.ok(r && r.estimated === true);
        assert.strictEqual(r.hops, 1);
        assert.ok(r.total_cost > 0 && r.total_transit_days > 0);
    });
    await t('applyConstraints relaxes progressively when nothing satisfies', () => {
        const { routes } = routeBuilder.buildRoutes('CNSHA', 'NLRTM', 5000, { maxTransfers: 2 });
        // an impossible transit constraint forces relaxation
        const { routes: kept, relaxed } = fallback.applyConstraints(routes, { max_transit_days: 1 });
        assert.ok(kept.length > 0);
        assert.ok(relaxed.includes('max_transit_days'));
    });
    await t('defaultModeForDistance picks road short, ocean long', () => {
        assert.strictEqual(fallback.defaultModeForDistance(300), 'road');
        assert.strictEqual(fallback.defaultModeForDistance(20000), 'ocean');
    });

    // ── api integration ─────────────────────────────────────────────────────────────
    section('apiIntegration (providers + retry + classification)');
    await t('registered rate provider overrides the built-in price, then resets', () => {
        const off = api.registerRateProvider({ name: 'test-rates', rate: () => ({ cost: 42 }) });
        const lane = { from: 'CNSHA', to: 'NLRTM', mode: 'ocean', distance_km: 19500, transit_days: 32, cost_rate: 0.88 };
        const opt = rates.selectCarrierForLane(lane, 5000, 'cheapest');
        assert.strictEqual(opt.cost, 42);
        assert.strictEqual(opt.source, 'test-rates');
        off();
        const reverted = rates.selectCarrierForLane(lane, 5000, 'cheapest');
        assert.notStrictEqual(reverted.cost, 42);
    });
    await t('registered lane provider augments the graph', () => {
        const off = api.registerLaneProvider({ name: 'test-lanes', lanesFrom: (hub) => (hub === 'CNSHA' ? [{ from: 'CNSHA', to: 'AEJEA', mode: 'ocean', distance_km: 6000, transit_days: 12, cost_rate: 0.8 }] : []) });
        assert.ok(net.lanesFrom('CNSHA').some((l) => l.to === 'AEJEA' && l.source === 'test-lanes'));
        off();
    });
    await t('callProvider retries TRANSIENT then succeeds; classifies errors', async () => {
        let n = 0;
        const out = await api.callProvider(async () => { n += 1; if (n < 2) throw new Error('timeout'); return 'ok'; }, { sleep: () => Promise.resolve() });
        assert.strictEqual(out, 'ok');
        assert.strictEqual(n, 2);
        assert.strictEqual(api.classifyError(new Error('connection reset')), 'transient');
        assert.strictEqual(api.classifyError(schema.routeError('no_route', 'x')), 'no_route');
    });
    await t('registry reports builtin-only after reset', () => {
        api.reset();
        assert.strictEqual(api.registry().mode, 'builtin-only');
    });

    // ── optimizer (end-to-end) ───────────────────────────────────────────────────────
    section('optimizer (end-to-end)');
    await t('optimize returns cheapest/fastest/balanced + ranked routes', () => {
        const out = optimizer.optimize(cnToNl());
        assert.ok(out.cheapest && out.fastest && out.balanced && out.recommended);
        assert.ok(out.routes.length > 0);
        assert.strictEqual(out.engine_version, schema.ENGINE_VERSION);
        assert.ok(out.cheapest.total_cost <= out.fastest.total_cost);          // cheap ≤ fast on cost
        assert.ok(out.fastest.total_transit_days <= out.cheapest.total_transit_days); // fast ≤ cheap on time
    });
    await t('strategy=cheapest makes recommended == cheapest', () => {
        const out = optimizer.optimize(cnToNl(), { strategy: 'cheapest' });
        assert.strictEqual(out.strategy, 'cheapest');
        assert.strictEqual(out.recommended.id, out.cheapest.id);
    });
    await t('allowed_modes=[ocean] yields ocean-only routes', () => {
        const out = optimizer.optimize(cnToNl({ allowed_modes: ['ocean'] }));
        assert.ok(out.routes.every((r) => r.modes.every((m) => m === 'ocean')));
    });
    await t('no network path falls back to an estimated direct route with a warning', () => {
        // CNSHA→USCHI has no DIRECT lane (Chicago is inland); maxTransfers=0 forbids
        // transshipment → the optimizer must synthesize a direct estimated route.
        const out = optimizer.optimize({ origin: { hub: 'CNSHA' }, destination: { hub: 'USCHI' }, weight_kg: 1000 }, { maxTransfers: 0 });
        assert.ok(out.routes.length > 0);
        assert.ok(out.routes.every((r) => r.estimated === true));
        assert.ok(out.warnings.some((w) => w.code === 'estimated_route'));
    });
    await t('invalid request throws a VALIDATION RouteError', () => {
        assert.throws(() => optimizer.optimize({ weight_kg: 0, origin: {}, destination: {} }), (e) => e.name === 'RouteError' && e.kind === 'validation');
    });
    await t('constraint max_cost is honored when satisfiable', () => {
        const base = optimizer.optimize(cnToNl());
        const cap = base.cheapest.total_cost + 1;
        const out = optimizer.optimize(cnToNl({ constraints: { max_cost: cap } }));
        assert.ok(out.routes.every((r) => r.total_cost <= cap));
    });

    // ── summary ──────────────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Logistics Optimization Agent verify: ${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('\nFailures:');
        failures.forEach((f) => console.log(`  ✗ ${f.name}: ${f.message}`));
        process.exit(1);
    }
    console.log('All assertions passed ✓');
})();
