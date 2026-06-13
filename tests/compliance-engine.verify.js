'use strict';
/**
 * Compliance & Sanctions Engine — standalone verification harness (Prompt 8).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script
 * exercises the PURE layers (normalize / rules / severity / report) + the default
 * KYC/AML hooks with a tiny built-in runner. No DB, no network — deterministic via
 * an injected clock.
 *
 *   node tests/compliance-engine.verify.js
 */
const assert = require('assert');
const norm = require('../service/compliance/normalize');
const dataset = require('../service/compliance/dataset');
const rules = require('../service/compliance/rules');
const severity = require('../service/compliance/severity');
const kycAml = require('../service/compliance/kycAml');
const report = require('../service/compliance/report');
const { CHECK, DECISION, SEVERITY } = require('../service/compliance/schema');

const NOW = new Date('2026-06-11T00:00:00Z');
let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
    try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
    catch (err) { fail += 1; failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
function section(title) { console.log(`\n${title}`); }

// Reference data straight from the dataset (the seed's source of truth).
const REF = {
    sanctionedCountries: dataset.sanctionedCountries(),
    namedParties: dataset.namedParties(),
    controlledGoods: dataset.controlledGoods(),
    tradeBans: dataset.tradeBans(),
};

const subj = (raw) => report.normalizeSubject(raw);
const run = (raw, lists) => rules.run(subj(raw), REF, lists || {});
const has = (violations, check) => violations.some((v) => v.check === check);
const ofCheck = (violations, check) => violations.filter((v) => v.check === check);

(async () => {
    // ── normalize ────────────────────────────────────────────────────────────
    section('normalize');
    t('normalizeCountry resolves alpha-3 + names', () => {
        assert.strictEqual(norm.normalizeCountry('USA'), 'US');
        assert.strictEqual(norm.normalizeCountry('Russian Federation'), 'RU');
        assert.strictEqual(norm.normalizeCountry('north korea'), 'KP');
        assert.strictEqual(norm.normalizeCountry('de'), 'DE');
        assert.strictEqual(norm.normalizeCountry(''), null);
    });
    t('normalizeCountry does NOT truncate unknown tokens to a false sanctioned code', () => {
        // "IRQ" (Iraq, not in synonyms) must NOT collapse to "IR" (Iran).
        assert.strictEqual(norm.normalizeCountry('IRQ'), null);
        assert.strictEqual(norm.normalizeCountry('Atlantis'), null);
    });
    t('nameMatches is alias + containment aware, word-bounded', () => {
        assert.ok(norm.nameMatches('Volga Trade Co., Ltd.', 'Volga Trading House', ['Volga Trade']));
        assert.ok(norm.nameMatches('ACME', 'ACME TRADING'));
        assert.ok(!norm.nameMatches('Miranda Logistics', 'Iran Shipping'));
        assert.ok(!norm.nameMatches('', 'Anything'));
    });
    t('hsPrefixMatches matches on chapter/heading prefix', () => {
        assert.ok(norm.hsPrefixMatches('930120', ['9301']));
        assert.ok(norm.hsPrefixMatches('8517.12', ['8517']));
        assert.ok(!norm.hsPrefixMatches('1006', ['9301']));
    });

    // ── sanctioned countries ──────────────────────────────────────────────────
    section('check: sanctioned countries');
    t('destination in a comprehensively embargoed country → critical violation', () => {
        const { violations } = run({ originCountry: 'US', destinationCountry: 'IR', goods: [{ description: 'pumps' }] });
        const v = ofCheck(violations, CHECK.SANCTIONED_COUNTRY);
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].severity, SEVERITY.CRITICAL);
        assert.strictEqual(v[0].subject, 'IR');
        assert.ok(v[0].details.roles.includes('destination'));
    });
    t('a clean corridor produces no sanctioned-country violation', () => {
        const { violations } = run({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'pumps' }] });
        assert.ok(!has(violations, CHECK.SANCTIONED_COUNTRY));
    });

    // ── sanctioned parties ──────────────────────────────────────────────────────
    section('check: sanctioned parties');
    t('a listed party name (via alias) trips the party check', () => {
        const { violations } = run({
            originCountry: 'US', destinationCountry: 'DE',
            parties: [{ name: 'Volga Trade LLC', role: 'buyer', country: 'DE' }],
        });
        const v = ofCheck(violations, CHECK.SANCTIONED_PARTY);
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].severity, SEVERITY.CRITICAL);
    });
    t('an unlisted party name does not trip the party check', () => {
        const { violations } = run({
            originCountry: 'US', destinationCountry: 'DE',
            parties: [{ name: 'Globex Widgets', role: 'buyer', country: 'DE' }],
        });
        assert.ok(!has(violations, CHECK.SANCTIONED_PARTY));
    });

    // ── controlled goods ─────────────────────────────────────────────────────────
    section('check: controlled goods (restricted / dual-use / prohibited)');
    t('firearms by HS prefix → restricted goods (high)', () => {
        const { violations } = run({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'sporting rifle', hsCode: '930120' }] });
        const v = ofCheck(violations, CHECK.RESTRICTED_GOODS);
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].severity, SEVERITY.HIGH);
    });
    t('encryption by keyword → dual-use goods (medium)', () => {
        const { violations } = run({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'strong encryption module' }] });
        const v = ofCheck(violations, CHECK.DUAL_USE_GOODS);
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].severity, SEVERITY.MEDIUM);
    });
    t('a CWC agent by keyword → prohibited goods (critical)', () => {
        const { violations } = run({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'sarin precursor batch' }] });
        const v = ofCheck(violations, CHECK.PROHIBITED_GOODS);
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].severity, SEVERITY.CRITICAL);
    });
    t('ordinary goods trip no controlled-goods check', () => {
        const { violations } = run({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'cotton t-shirts', hsCode: '610910' }] });
        assert.ok(!has(violations, CHECK.RESTRICTED_GOODS));
        assert.ok(!has(violations, CHECK.DUAL_USE_GOODS));
        assert.ok(!has(violations, CHECK.PROHIBITED_GOODS));
    });

    // ── trade bans (direction-aware) ──────────────────────────────────────────────
    section('check: export / import bans');
    t('export of dual-use category to Russia → trade ban', () => {
        const { violations } = run({ originCountry: 'DE', destinationCountry: 'RU', goods: [{ description: 'controller', category: 'dual_use' }] });
        const v = ofCheck(violations, CHECK.TRADE_BAN);
        assert.ok(v.length >= 1, 'expected a trade-ban violation');
        assert.ok(v.some((x) => x.details.direction === 'export'));
    });
    t('any goods to North Korea → comprehensive ban (critical) + sanctioned country', () => {
        const { violations } = run({ originCountry: 'CN', destinationCountry: 'KP', goods: [{ description: 'rice' }] });
        assert.ok(has(violations, CHECK.TRADE_BAN));
        assert.ok(has(violations, CHECK.SANCTIONED_COUNTRY));
    });
    t('import FROM Iran into the US → US embargo (import direction)', () => {
        const { violations } = run({ originCountry: 'IR', destinationCountry: 'US', goods: [{ description: 'carpets' }] });
        const v = ofCheck(violations, CHECK.TRADE_BAN);
        assert.ok(v.some((x) => x.details.ban_code === 'BAN-US-IR'));
        assert.ok(v.some((x) => x.details.direction === 'import'));
    });

    // ── blacklist / whitelist ──────────────────────────────────────────────────────
    section('check: tenant blacklist / whitelist');
    t('tenant blacklist denies an otherwise-clean country', () => {
        const lists = { blacklist: [{ subject_type: 'country', value: 'BR', severity: 'high', reason: 'internal policy' }] };
        const { violations } = run({ originCountry: 'US', destinationCountry: 'BR', goods: [{ description: 'pumps' }] }, lists);
        const v = ofCheck(violations, CHECK.BLACKLIST);
        assert.strictEqual(v.length, 1);
        assert.strictEqual(v[0].subject, 'BR');
    });
    t('tenant whitelist de-escalates a sanctioned-country hit to informational', () => {
        const lists = { whitelist: [{ subject_type: 'country', value: 'RU' }] };
        const { violations } = run({ originCountry: 'DE', destinationCountry: 'RU', goods: [{ description: 'pumps' }] }, lists);
        const sc = ofCheck(violations, CHECK.SANCTIONED_COUNTRY)[0];
        assert.ok(sc, 'sanctioned-country violation still recorded');
        assert.strictEqual(sc.whitelisted, true);
        assert.strictEqual(sc.severity, SEVERITY.NONE);
    });
    t('whitelist can NEVER de-escalate a prohibited good', () => {
        const lists = { whitelist: [{ subject_type: 'good', value: 'sarin' }] };
        const { violations } = run({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'sarin precursor' }] }, lists);
        const v = ofCheck(violations, CHECK.PROHIBITED_GOODS)[0];
        assert.ok(v);
        assert.notStrictEqual(v.severity, SEVERITY.NONE);
    });
    t('whitelist can NEVER de-escalate a CRITICAL sanctioned country (comprehensive embargo)', () => {
        const lists = { whitelist: [{ subject_type: 'country', value: 'IR' }] };
        const { violations } = run({ originCountry: 'US', destinationCountry: 'IR', goods: [{ description: 'pumps' }] }, lists);
        const v = ofCheck(violations, CHECK.SANCTIONED_COUNTRY)[0];
        assert.ok(v);
        assert.notStrictEqual(v.whitelisted, true);
        assert.strictEqual(v.severity, SEVERITY.CRITICAL);
        const s = severity.score(violations);
        assert.strictEqual(s.decision, DECISION.BLOCK); // self-clearing an embargo is impossible
    });
    t('whitelist can NEVER de-escalate a sanctioned PARTY', () => {
        const lists = { whitelist: [{ subject_type: 'party', value: 'Volga Trade' }] };
        const { violations } = run({
            originCountry: 'US', destinationCountry: 'DE',
            parties: [{ name: 'Volga Trade LLC', role: 'buyer', country: 'DE' }],
        }, lists);
        const v = ofCheck(violations, CHECK.SANCTIONED_PARTY)[0];
        assert.ok(v);
        assert.notStrictEqual(v.whitelisted, true);
    });

    // ── severity scoring + decision ──────────────────────────────────────────────
    section('severity scoring + decision');
    t('no violations → clear, risk 0, severity none', () => {
        const s = severity.score([]);
        assert.strictEqual(s.decision, DECISION.CLEAR);
        assert.strictEqual(s.risk_score, 0);
        assert.strictEqual(s.severity, SEVERITY.NONE);
    });
    t('a lone critical saturates risk to 100 and blocks', () => {
        const { violations } = run({ originCountry: 'US', destinationCountry: 'IR', goods: [{ description: 'pumps' }] });
        const s = severity.score(violations);
        assert.strictEqual(s.risk_score, 100);
        assert.strictEqual(s.severity, SEVERITY.CRITICAL);
        assert.strictEqual(s.decision, DECISION.BLOCK);
        assert.strictEqual(s.blocking, true);
    });
    t('a medium-only finding → review, not block', () => {
        const { violations } = run({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'strong encryption module' }] });
        const s = severity.score(violations);
        assert.strictEqual(s.decision, DECISION.REVIEW);
        assert.strictEqual(s.severity, SEVERITY.MEDIUM);
        assert.strictEqual(s.risk_score, 25);
    });
    t('whitelisted violations do not count toward risk/decision', () => {
        const lists = { whitelist: [{ subject_type: 'country', value: 'RU' }] };
        const { violations } = run({ originCountry: 'DE', destinationCountry: 'RU', goods: [{ description: 'pumps' }] }, lists);
        const s = severity.score(violations);
        assert.strictEqual(s.actionable_count, 0);
        assert.strictEqual(s.decision, DECISION.CLEAR);
    });
    t('a failed KYC/AML hook forces block irrespective of violations', () => {
        const s = severity.score([], { kycStatus: 'failed', amlStatus: 'passed' });
        assert.strictEqual(s.decision, DECISION.BLOCK);
    });

    // ── KYC / AML hooks (default heuristic) ───────────────────────────────────────
    section('KYC / AML hooks (default heuristic)');
    t('KYC passes when every party carries name + country', async () => {
        const hooks = await kycAml.screen(subj({ parties: [{ name: 'Globex', role: 'buyer', country: 'DE' }, { name: 'Initech', role: 'seller', country: 'US' }] }));
        assert.strictEqual(hooks.kyc.status, 'passed');
    });
    t('KYC needs review when a party is missing its country', async () => {
        const hooks = await kycAml.screen(subj({ parties: [{ name: 'Globex', role: 'buyer' }] }));
        assert.strictEqual(hooks.kyc.status, 'review');
    });
    t('AML escalates a high-value flow into a high-risk jurisdiction', async () => {
        const hooks = await kycAml.screen(subj({ originCountry: 'US', destinationCountry: 'RU', totalValue: 2000000, parties: [{ name: 'X', country: 'RU' }] }));
        assert.strictEqual(hooks.aml.status, 'review');
    });

    // ── report.build (composition) ───────────────────────────────────────────────
    section('report.build — composition + shape');
    t('clean subject → clear report with the required fields', async () => {
        const r = report.build({ subject: subj({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'pumps' }] }), refData: REF, now: NOW });
        ['decision', 'risk_score', 'severity', 'blocking', 'violation_count', 'violations', 'checks', 'summary'].forEach((k) => {
            assert.ok(r[k] !== undefined, `report.${k} present`);
        });
        assert.strictEqual(r.decision, DECISION.CLEAR);
        assert.strictEqual(r.violation_count, 0);
        assert.strictEqual(r.screened_at, NOW.toISOString());
    });
    t('blocking subject → block report with violations + recommendation', async () => {
        const hooks = await kycAml.screen(subj({ originCountry: 'US', destinationCountry: 'KP', goods: [{ description: 'machine parts' }] }));
        const r = report.build({ subject: subj({ originCountry: 'US', destinationCountry: 'KP', goods: [{ description: 'machine parts' }] }), refData: REF, hooks, now: NOW });
        assert.strictEqual(r.decision, DECISION.BLOCK);
        assert.ok(r.violation_count >= 1);
        assert.ok(/Do not proceed/i.test(r.summary.recommendation));
    });
    t('identical inputs → identical report (determinism)', () => {
        const input = { originCountry: 'US', destinationCountry: 'IR', goods: [{ description: 'pumps' }] };
        const a = report.build({ subject: subj(input), refData: REF, now: NOW });
        const b = report.build({ subject: subj(input), refData: REF, now: NOW });
        assert.deepStrictEqual(a, b);
    });
    t('checks summary records every check that ran', () => {
        const r = report.build({ subject: subj({ originCountry: 'US', destinationCountry: 'DE', goods: [{ description: 'pumps' }] }), refData: REF, now: NOW });
        [CHECK.SANCTIONED_COUNTRY, CHECK.SANCTIONED_PARTY, CHECK.RESTRICTED_GOODS, CHECK.DUAL_USE_GOODS, CHECK.TRADE_BAN].forEach((c) => {
            assert.ok(r.checks[c] && r.checks[c].ran === true, `check ${c} ran`);
        });
    });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`compliance-engine: ${pass} passed, ${fail} failed`);
    if (fail > 0) {
        console.log('\nFAILURES:');
        failures.forEach((f) => console.log(`  • ${f.name}: ${f.message}`));
        process.exit(1);
    }
    process.exit(0);
})();
