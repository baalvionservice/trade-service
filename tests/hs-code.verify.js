'use strict';
/**
 * HS Code Intelligence Engine — standalone verification harness (Prompt 7).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script
 * runs the PURE assertions using a tiny built-in runner. No DB, no network —
 * fully deterministic (engine clock is injected).
 *
 *   node tests/hs-code.verify.js
 */
const assert = require('assert');
const norm = require('../service/hscode/normalize');
const db = require('../service/hscode/hsDatabase');
const search = require('../service/hscode/search');
const ai = require('../service/hscode/aiSuggester');
const fallback = require('../service/hscode/fallbackRules');
const compliance = require('../service/hscode/compliance');
const duty = require('../service/hscode/duty');
const report = require('../service/hscode/report');
const engine = require('../service/hscode/hsEngine');
const { METHOD, FLAG, CONFIDENCE_BAND } = require('../service/hscode/schema');

const NOW = new Date('2026-06-11T00:00:00Z');
let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
    try {
        await fn();
        pass += 1;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail += 1;
        failures.push({ name, message: err.message });
        console.log(`  ✗ ${name}\n      ${err.message}`);
    }
}
function section(title) { console.log(`\n${title}`); }

(async () => {
    // ── normalize ──────────────────────────────────────────────────────────
    section('normalize');
    await t('normalizeHsCode strips punctuation + derives prefixes', () => {
        const n = norm.normalizeHsCode('0901.11.00');
        assert.strictEqual(n.code, '09011100');
        assert.strictEqual(n.chapter, '09');
        assert.strictEqual(n.heading, '0901');
        assert.strictEqual(n.subheading, '090111');
        assert.strictEqual(n.national, '09011100');
    });
    await t('normalizeHsCode rejects too-short input', () => {
        assert.strictEqual(norm.normalizeHsCode('0'), null);
    });
    await t('isHsCodeLike requires 6+ digits', () => {
        assert.strictEqual(norm.isHsCodeLike('0901'), false);
        assert.strictEqual(norm.isHsCodeLike('090111'), true);
    });
    await t('tokenize drops stopwords + dups', () => {
        const toks = norm.tokenize('New cotton T-SHIRTS for the men');
        assert.ok(toks.includes('cotton'));
        assert.ok(!toks.includes('the'));
        assert.ok(!toks.includes('new'));
    });
    await t('normalizeCountry maps alpha-3 + upper', () => {
        assert.strictEqual(norm.normalizeCountry('ind'), 'IN');
        assert.strictEqual(norm.normalizeCountry('us'), 'US');
        assert.strictEqual(norm.normalizeCountry(''), null);
    });

    // ── database structure ─────────────────────────────────────────────────
    section('database');
    await t('findByCode resolves 6-digit + national + heading fallback', () => {
        assert.strictEqual(db.findByCode('090111').description.includes('Coffee'), true);
        assert.strictEqual(db.findByCode('0901110015').hs_code, '090111'); // US national
        assert.strictEqual(db.findByCode('090199').heading, '0901');       // heading fallback
    });
    await t('multi-country tariff lines present', () => {
        const line = db.tariffLine('851712', 'IN');
        assert.ok(line && line.duty === 20 && line.national === '85171290');
        assert.ok(db.tariffLine('851712', 'US'));
        assert.ok(db.tariffLine('851712', 'GB'));
    });

    // ── search + confidence scoring ────────────────────────────────────────
    section('search');
    await t('search finds smartphone with high confidence', () => {
        const r = search.search({ query: 'Apple smartphone mobile phone', country: 'IN' });
        assert.strictEqual(r[0].hs_code, '851712');
        assert.strictEqual(r[0].method, METHOD.SEARCH);
        assert.ok(r[0].confidence >= 75, `expected high confidence, got ${r[0].confidence}`);
        assert.strictEqual(r[0].confidence_band, CONFIDENCE_BAND.HIGH);
        assert.strictEqual(r[0].national_code, '85171290');
    });
    await t('search returns empty for gibberish', () => {
        assert.strictEqual(search.search({ query: 'zzqq xxyy' }).length, 0);
    });
    await t('search ranks copper cathodes top', () => {
        const r = search.search({ query: 'copper cathodes grade A' });
        assert.strictEqual(r[0].hs_code, '740311');
    });

    // ── AI suggester (mockable) ────────────────────────────────────────────
    section('aiSuggester');
    await t('heuristic provider suggests + reasons', async () => {
        const r = await ai.suggest({ product: 'laptop notebook computer', country: 'IN' });
        assert.strictEqual(r.provider, 'heuristic');
        assert.strictEqual(r.suggestions[0].hs_code, '847130');
        assert.strictEqual(r.suggestions[0].method, METHOD.AI);
        assert.ok(typeof r.reasoning === 'string');
    });
    await t('registerProvider swaps the engine (mock)', async () => {
        ai.registerProvider({
            name: 'mock',
            async suggest() {
                return { suggestions: [{ hs_code: '300490', confidence: 91 }], reasoning: 'mock' };
            },
        });
        const r = await ai.suggest({ product: 'anything' });
        assert.strictEqual(r.provider, 'mock');
        assert.strictEqual(r.suggestions[0].hs_code, '300490');
        assert.strictEqual(r.suggestions[0].confidence, 91);
        ai.resetProvider();
        assert.strictEqual(ai.getProvider().name, 'heuristic');
    });
    await t('a throwing provider degrades, never crashes', async () => {
        ai.registerProvider({ name: 'boom', async suggest() { throw new Error('kaboom'); } });
        const r = await ai.suggest({ product: 'x' });
        assert.strictEqual(r.degraded, true);
        assert.deepStrictEqual(r.suggestions, []);
        ai.resetProvider();
    });

    // ── fallback rules engine ──────────────────────────────────────────────
    section('fallbackRules');
    await t('fallback maps unknown ferrous product to steel chapter', () => {
        const r = fallback.run({ product: 'galvanized ferrous structural beam steel' });
        assert.ok(r.length >= 1);
        assert.strictEqual(r[0].method, METHOD.FALLBACK);
        assert.strictEqual(r[0].chapter, '72');
        assert.ok(r[0].confidence <= 55, 'fallback confidence is capped');
    });
    await t('fallback empty for empty product', () => {
        assert.strictEqual(fallback.run({ product: '' }).length, 0);
    });

    // ── compliance flags ───────────────────────────────────────────────────
    section('compliance');
    await t('firearms flagged controlled/critical', () => {
        const flags = compliance.evaluate({ hsCode: '930200', country: 'IN' });
        const codes = flags.map((f) => f.code);
        assert.ok(codes.includes(FLAG.EXPORT_CONTROLLED));
        assert.ok(codes.includes(FLAG.PROHIBITED));   // IN national line marks prohibited
        assert.strictEqual(compliance.isBlocking(flags), true);
    });
    await t('pharma requires licence', () => {
        const flags = compliance.evaluate({ hsCode: '300490', country: 'IN' });
        assert.ok(flags.some((f) => f.code === FLAG.LICENSE_REQUIRED && f.requires));
    });
    await t('benign laptop has no blocking flags', () => {
        const flags = compliance.evaluate({ hsCode: '847130', country: 'IN' });
        assert.strictEqual(compliance.isBlocking(flags), false);
    });
    await t('unknown country yields NO_TARIFF_LINE flag', () => {
        const flags = compliance.evaluate({ hsCode: '847130', country: 'BR' });
        assert.ok(flags.some((f) => f.code === FLAG.NO_TARIFF_LINE));
    });

    // ── duty estimation hooks ──────────────────────────────────────────────
    section('duty');
    await t('estimateDuty computes duty + VAT on duty-inclusive base', () => {
        // smartphone 851712 into IN: duty 20%, vat 18%, value 1000
        const e = duty.estimateDuty({ hsCode: '851712', country: 'IN', customsValue: 1000, currency: 'USD' });
        assert.strictEqual(e.available, true);
        assert.strictEqual(e.duty_rate, 20);
        assert.strictEqual(e.duty_amount, 200);          // 1000 * 20%
        assert.strictEqual(e.tax_base, 1200);            // 1000 + 200
        assert.strictEqual(e.vat_amount, 216);           // 1200 * 18%
        assert.strictEqual(e.total_landed_cost, 1416);   // 1000 + 200 + 216
    });
    await t('estimateDuty unavailable for unknown country', () => {
        const e = duty.estimateDuty({ hsCode: '851712', country: 'BR', customsValue: 1000 });
        assert.strictEqual(e.available, false);
    });
    await t('registerRateProvider swaps the source (hook)', () => {
        duty.registerRateProvider({
            name: 'mock-feed',
            rateFor() { return { duty_rate: 10, vat_rate: 0, source: 'mock-feed' }; },
        });
        const e = duty.estimateDuty({ hsCode: '847130', country: 'IN', customsValue: 500 });
        assert.strictEqual(e.provider, 'mock-feed');
        assert.strictEqual(e.duty_amount, 50);
        duty.resetRateProvider();
    });

    // ── report fusion ──────────────────────────────────────────────────────
    section('report');
    await t('fuse merges duplicate codes + agreement bonus', () => {
        const merged = report.fuse([
            { hs_code: '851712', method: METHOD.SEARCH, confidence: 70, matched_on: ['keyword:phone'], description: 'x', source: 'database' },
            { hs_code: '851712', method: METHOD.AI, confidence: 72, matched_on: ['ai'], description: 'x', source: 'ai' },
            { hs_code: '847130', method: METHOD.SEARCH, confidence: 60, matched_on: [], description: 'y', source: 'database' },
        ]);
        assert.strictEqual(merged[0].hs_code, '851712');
        assert.ok(merged[0].methods.includes('search') && merged[0].methods.includes('ai'));
        assert.ok(merged[0].confidence > 72, 'agreement bonus applied');
    });

    // ── engine (full pipeline, stateless) ──────────────────────────────────
    section('engine.suggest');
    await t('full pipeline: product → code + flags + duty', async () => {
        const r = await engine.suggest({
            product: 'cellular smartphone mobile handset',
            destinationCountry: 'IN', customsValue: 1000, currency: 'USD', now: NOW,
        });
        assert.strictEqual(r.best.hs_code, '851712');
        assert.strictEqual(r.query.destination_country, 'IN');
        assert.strictEqual(r.duty_estimate.total_landed_cost, 1416);
        assert.strictEqual(r.summary.needs_review, false);
        assert.strictEqual(r.generated_at, NOW.toISOString());
    });
    await t('exact asserted code yields confidence 100 + method exact', async () => {
        const r = await engine.suggest({ product: '', hsCode: '0901.11', destinationCountry: 'US', now: NOW });
        assert.strictEqual(r.best.hs_code, '090111');
        assert.strictEqual(r.best.method, METHOD.EXACT);
        assert.strictEqual(r.best.confidence, 100);
    });
    await t('controlled goods pipeline flags blocking', async () => {
        const r = await engine.suggest({ product: 'pistol handgun firearm', destinationCountry: 'IN', now: NOW });
        assert.strictEqual(r.best.hs_code, '930200');
        assert.strictEqual(r.summary.blocking, true);
        assert.ok(r.compliance_flags.length > 0);
    });
    await t('obscure product is rescued by the fallback rules engine', async () => {
        // "ferrous" is a fallback-rule signal but not a search keyword → only the
        // fallback engine can place this, proving the safety net engages.
        const r = await engine.suggest({ product: 'ferrous alloy billet stock', destinationCountry: 'IN', now: NOW });
        assert.ok(r.best, 'pipeline always returns a candidate');
        assert.ok(r.suggestions.some((s) => s.method === METHOD.FALLBACK), 'fallback candidate present');
    });

    section('engine.lookup');
    await t('lookup resolves national line + duty hook', () => {
        const r = engine.lookup({ hsCode: '740311', country: 'IN', customsValue: 1000 });
        assert.strictEqual(r.hs_code, '740311');
        assert.strictEqual(r.national_code, '74031100');
        assert.ok(r.duty_estimate.available);
        assert.ok(Array.isArray(r.available_countries) && r.available_countries.length >= 2);
    });
    await t('lookup throws on unknown code', () => {
        assert.throws(() => engine.lookup({ hsCode: '999999' }), /not found/);
    });

    // ── summary ────────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(50)}`);
    console.log(`HS Code Intelligence Engine — ${pass} passed, ${fail} failed`);
    if (fail > 0) {
        console.log('\nFailures:');
        for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
        process.exit(1);
    }
    process.exit(0);
})();
