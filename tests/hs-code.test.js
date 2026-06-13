'use strict';
// HS Code Intelligence Engine — tests (Prompt 7).
//
// PURE suites only (no DB): normalizers, the HS database structure + multi-country
// tariff mapping, keyword search + confidence scoring, the pluggable/mockable AI
// suggester, the fallback rules engine, compliance-flag derivation, the duty
// estimation hooks, report fusion and the stateless engine.suggest()/lookup()
// pipeline. Everything is deterministic — the clock is injected and the default
// providers are network-free.
//
// NOTE: jest is currently broken repo-wide (jest-runtime clearMocksOnScope
// version skew). A standalone runner — `node tests/hs-code.verify.js` — executes
// these same assertions today; this file is the jest mirror for when the runner
// is repaired.

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

afterEach(() => { ai.resetProvider(); duty.resetRateProvider(); });

describe('normalize', () => {
    test('normalizeHsCode strips punctuation and derives prefixes', () => {
        const n = norm.normalizeHsCode('0901.11.00');
        expect(n.code).toBe('09011100');
        expect(n.chapter).toBe('09');
        expect(n.heading).toBe('0901');
        expect(n.subheading).toBe('090111');
    });
    test('isHsCodeLike requires six or more digits', () => {
        expect(norm.isHsCodeLike('0901')).toBe(false);
        expect(norm.isHsCodeLike('090111')).toBe(true);
    });
    test('normalizeCountry maps alpha-3 and uppercases', () => {
        expect(norm.normalizeCountry('ind')).toBe('IN');
        expect(norm.normalizeCountry('')).toBeNull();
    });
});

describe('database structure', () => {
    test('findByCode resolves subheading, national and heading fallback', () => {
        expect(db.findByCode('090111').description).toMatch(/Coffee/);
        expect(db.findByCode('0901110015').hs_code).toBe('090111');
        expect(db.findByCode('090199').heading).toBe('0901');
    });
    test('carries multi-country tariff lines', () => {
        expect(db.tariffLine('851712', 'IN').national).toBe('85171290');
        expect(db.tariffLine('851712', 'US')).toBeTruthy();
        expect(db.tariffLine('851712', 'GB')).toBeTruthy();
    });
});

describe('search + confidence scoring', () => {
    test('classifies a smartphone with high confidence', () => {
        const r = search.search({ query: 'Apple smartphone mobile phone', country: 'IN' });
        expect(r[0].hs_code).toBe('851712');
        expect(r[0].confidence).toBeGreaterThanOrEqual(75);
        expect(r[0].confidence_band).toBe(CONFIDENCE_BAND.HIGH);
    });
    test('returns nothing for gibberish', () => {
        expect(search.search({ query: 'zzqq xxyy' })).toHaveLength(0);
    });
});

describe('AI suggester (mockable)', () => {
    test('heuristic provider produces ranked AI suggestions', async () => {
        const r = await ai.suggest({ product: 'laptop notebook computer', country: 'IN' });
        expect(r.provider).toBe('heuristic');
        expect(r.suggestions[0].hs_code).toBe('847130');
        expect(r.suggestions[0].method).toBe(METHOD.AI);
    });
    test('registerProvider swaps in a mock model', async () => {
        ai.registerProvider({ name: 'mock', async suggest() { return { suggestions: [{ hs_code: '300490', confidence: 91 }] }; } });
        const r = await ai.suggest({ product: 'x' });
        expect(r.provider).toBe('mock');
        expect(r.suggestions[0].hs_code).toBe('300490');
    });
    test('a throwing provider degrades instead of crashing', async () => {
        ai.registerProvider({ name: 'boom', async suggest() { throw new Error('kaboom'); } });
        const r = await ai.suggest({ product: 'x' });
        expect(r.degraded).toBe(true);
        expect(r.suggestions).toEqual([]);
    });
});

describe('fallback rules engine', () => {
    test('maps an unknown ferrous product to the steel chapter, confidence-capped', () => {
        const r = fallback.run({ product: 'galvanized ferrous structural beam steel' });
        expect(r[0].method).toBe(METHOD.FALLBACK);
        expect(r[0].chapter).toBe('72');
        expect(r[0].confidence).toBeLessThanOrEqual(55);
    });
});

describe('compliance flags', () => {
    test('flags firearms as controlled and blocking', () => {
        const flags = compliance.evaluate({ hsCode: '930200', country: 'IN' });
        expect(flags.map((f) => f.code)).toEqual(expect.arrayContaining([FLAG.EXPORT_CONTROLLED, FLAG.PROHIBITED]));
        expect(compliance.isBlocking(flags)).toBe(true);
    });
    test('requires a licence for pharmaceuticals', () => {
        const flags = compliance.evaluate({ hsCode: '300490', country: 'IN' });
        expect(flags.some((f) => f.code === FLAG.LICENSE_REQUIRED && f.requires)).toBe(true);
    });
    test('benign laptop is not blocking', () => {
        expect(compliance.isBlocking(compliance.evaluate({ hsCode: '847130', country: 'IN' }))).toBe(false);
    });
});

describe('duty estimation hooks', () => {
    test('computes duty and VAT on the duty-inclusive base', () => {
        const e = duty.estimateDuty({ hsCode: '851712', country: 'IN', customsValue: 1000 });
        expect(e.duty_amount).toBe(200);
        expect(e.vat_amount).toBe(216);
        expect(e.total_landed_cost).toBe(1416);
    });
    test('registerRateProvider swaps the rate source', () => {
        duty.registerRateProvider({ name: 'mock-feed', rateFor() { return { duty_rate: 10, vat_rate: 0, source: 'mock-feed' }; } });
        const e = duty.estimateDuty({ hsCode: '847130', country: 'IN', customsValue: 500 });
        expect(e.provider).toBe('mock-feed');
        expect(e.duty_amount).toBe(50);
    });
});

describe('report fusion', () => {
    test('merges duplicate codes and applies an agreement bonus', () => {
        const merged = report.fuse([
            { hs_code: '851712', method: METHOD.SEARCH, confidence: 70, matched_on: [], description: 'x', source: 'database' },
            { hs_code: '851712', method: METHOD.AI, confidence: 72, matched_on: [], description: 'x', source: 'ai' },
        ]);
        expect(merged[0].methods).toEqual(expect.arrayContaining(['search', 'ai']));
        expect(merged[0].confidence).toBeGreaterThan(72);
    });
});

describe('engine pipeline (stateless)', () => {
    test('product → code + compliance flags + duty estimate', async () => {
        const r = await engine.suggest({ product: 'cellular smartphone handset', destinationCountry: 'IN', customsValue: 1000, now: NOW });
        expect(r.best.hs_code).toBe('851712');
        expect(r.duty_estimate.total_landed_cost).toBe(1416);
        expect(r.summary.needs_review).toBe(false);
    });
    test('asserted exact code is full confidence', async () => {
        const r = await engine.suggest({ product: '', hsCode: '0901.11', destinationCountry: 'US', now: NOW });
        expect(r.best.method).toBe(METHOD.EXACT);
        expect(r.best.confidence).toBe(100);
    });
    test('controlled goods produce a blocking verdict', async () => {
        const r = await engine.suggest({ product: 'pistol handgun firearm', destinationCountry: 'IN', now: NOW });
        expect(r.best.hs_code).toBe('930200');
        expect(r.summary.blocking).toBe(true);
    });
    test('lookup resolves a national line, flags and duty hook', () => {
        const r = engine.lookup({ hsCode: '740311', country: 'IN', customsValue: 1000 });
        expect(r.national_code).toBe('74031100');
        expect(r.duty_estimate.available).toBe(true);
    });
});
