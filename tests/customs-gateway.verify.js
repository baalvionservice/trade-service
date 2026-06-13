'use strict';
/**
 * Customs Gateway Abstraction Layer — standalone verification harness (Prompt 9).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script
 * runs the PURE assertions (vocabulary, normalizers, the four connectors, the base
 * submission pipeline + retry mechanism + response normalization, and the registry)
 * with a tiny built-in runner. No DB, no network — connector retry sleeps are
 * stubbed so it is fully deterministic.
 *
 *   node tests/customs-gateway.verify.js
 */
const assert = require('assert');

const schema = require('../service/customs/schema');
const norm = require('../service/customs/normalize');
const registry = require('../service/customs/connectors');
const { CustomsConnector } = require('../service/customs/connectors/baseConnector');
const { IndiaConnector } = require('../service/customs/connectors/indiaConnector');
const { USConnector } = require('../service/customs/connectors/usConnector');
const { EUConnector } = require('../service/customs/connectors/euConnector');
const { UAEConnector } = require('../service/customs/connectors/uaeConnector');

const noop = () => Promise.resolve();
// Fast connectors: zero-delay retry backoff so the harness is instant + deterministic.
const india = new IndiaConnector({ sleep: noop });
const us = new USConnector({ sleep: noop });
const eu = new EUConnector({ sleep: noop });
const uae = new UAEConnector({ sleep: noop });

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

// ── Declaration fixtures (valid per jurisdiction). ───────────────────────────
const indiaDecl = (simulate) => ({
    entry_type: 'import', destination_country: 'IN', origin_country: 'CN', incoterm: 'CIF',
    currency: 'INR', customs_value: 250000, reference: 'IN-REF-1',
    importer: { name: 'Acme India Pvt Ltd', iec: 'AAACA1234M', country: 'IN' },
    line_items: [{ hs_code: '85171200', description: 'Smartphones', quantity: 100, unit: 'NOS', unit_value: 2500, origin_country: 'CN' }],
    metadata: simulate ? { simulate } : {},
});
const usDecl = (simulate) => ({
    entry_type: 'import', destination_country: 'US', origin_country: 'DE', incoterm: 'DAP',
    currency: 'USD', customs_value: 50000, reference: 'US-REF-1',
    importer: { name: 'Acme USA Inc', tax_id: '12-3456789', country: 'US' },
    line_items: [{ hs_code: '8471300000', description: 'Laptops', quantity: 20, unit: 'EA', unit_value: 2500, origin_country: 'DE' }],
    metadata: simulate ? { simulate } : {},
});
const euDecl = (simulate) => ({
    entry_type: 'import', destination_country: 'DE', origin_country: 'US', incoterm: 'CIP',
    currency: 'EUR', customs_value: 40000, reference: 'EU-REF-1',
    declarant: { name: 'Acme GmbH', eori: 'DE123456789012345', country: 'DE' },
    importer: { name: 'Acme GmbH', eori: 'DE123456789012345', country: 'DE' },
    line_items: [{ hs_code: '84713000', description: 'Laptops', quantity: 15, unit: 'EA', unit_value: 2500, origin_country: 'US' }],
    metadata: simulate ? { simulate } : {},
});
const uaeDecl = (simulate) => ({
    entry_type: 'import', destination_country: 'AE', origin_country: 'IN', incoterm: 'CFR',
    currency: 'AED', customs_value: 120000, reference: 'AE-REF-1',
    importer: { name: 'Acme Trading LLC', tax_id: 'TRN100200300400', country: 'AE' },
    line_items: [{ hs_code: '610910', description: 'Cotton T-shirts', quantity: 5000, unit: 'PCS', unit_value: 20, origin_country: 'IN' }],
    metadata: simulate ? { simulate } : {},
});

(async () => {
    // ── schema vocabulary ────────────────────────────────────────────────────
    section('schema');
    await t('channelForCountry routes IN/US/AE + EU members', () => {
        assert.strictEqual(schema.channelForCountry('IN'), schema.CHANNEL.ICEGATE);
        assert.strictEqual(schema.channelForCountry('us'), schema.CHANNEL.ACE);
        assert.strictEqual(schema.channelForCountry('AE'), schema.CHANNEL.UAE_MIRSAL);
        assert.strictEqual(schema.channelForCountry('DE'), schema.CHANNEL.EU_CDS);
        assert.strictEqual(schema.channelForCountry('FR'), schema.CHANNEL.EU_CDS);
        assert.strictEqual(schema.channelForCountry('CN'), null);
    });
    await t('normalizedResponse factory enforces channel + status', () => {
        const r = schema.normalizedResponse({ channel: schema.CHANNEL.ACE, status: schema.STATUS.ACCEPTED, accepted: true, gateway_reference: 'ENT1' });
        assert.strictEqual(r.channel, 'ace');
        assert.strictEqual(r.accepted, true);
        assert.throws(() => schema.normalizedResponse({ channel: 'bogus' }));
        assert.throws(() => schema.normalizedResponse({ channel: schema.CHANNEL.ACE, status: 'nope' }));
    });
    await t('GatewayError classifies retryable kinds', () => {
        assert.strictEqual(schema.gatewayError(schema.FAILURE_KIND.TRANSIENT, 'x').retryable, true);
        assert.strictEqual(schema.gatewayError(schema.FAILURE_KIND.PERMANENT, 'x').retryable, false);
        assert.strictEqual(schema.gatewayError(schema.FAILURE_KIND.VALIDATION, 'x').retryable, false);
    });
    await t('status helpers identify terminal + recoverable', () => {
        assert.strictEqual(schema.isTerminal(schema.STATUS.ACCEPTED), true);
        assert.strictEqual(schema.isTerminal(schema.STATUS.FAILED), false);
        assert.strictEqual(schema.isRecoverable(schema.STATUS.FAILED), true);
    });

    // ── normalize ─────────────────────────────────────────────────────────────
    section('normalize');
    await t('normalizeCountry maps long-form + alpha-3', () => {
        assert.strictEqual(norm.normalizeCountry('India'), 'IN');
        assert.strictEqual(norm.normalizeCountry('usa'), 'US');
        assert.strictEqual(norm.normalizeCountry('ARE'), 'AE');
        assert.strictEqual(norm.normalizeCountry('de'), 'DE');
    });
    await t('normalizeDeclaration derives customs_value from lines when absent', () => {
        const d = norm.normalizeDeclaration({
            destination_country: 'US', origin_country: 'CN',
            line_items: [{ hs_code: '8471', quantity: 2, unit_value: 100 }, { hs_code: '8517', value: 50 }],
        });
        assert.strictEqual(d.customs_value, 250); // 2*100 + 50
        assert.strictEqual(d.line_items[0].line_no, 1);
    });
    await t('baseValidationErrors flags missing essentials', () => {
        const errs = norm.baseValidationErrors(norm.normalizeDeclaration({ entry_type: 'import' }));
        const codes = errs.map((e) => e.code);
        assert.ok(codes.includes('MISSING_DESTINATION'));
        assert.ok(codes.includes('NO_LINE_ITEMS'));
        assert.ok(codes.includes('MISSING_IMPORTER'));
    });
    await t('a complete declaration passes base validation', () => {
        const errs = norm.baseValidationErrors(norm.normalizeDeclaration(indiaDecl()));
        assert.strictEqual(errs.length, 0);
    });

    // ── base interface contract ───────────────────────────────────────────────
    section('base interface');
    await t('CustomsConnector is abstract (cannot be instantiated)', () => {
        assert.throws(() => new CustomsConnector({ channel: schema.CHANNEL.ACE }), /abstract/);
    });
    await t('every connector extends CustomsConnector', () => {
        [india, us, eu, uae].forEach((c) => assert.ok(c instanceof CustomsConnector));
    });

    // ── connector jurisdiction validation ─────────────────────────────────────
    section('jurisdiction validation');
    await t('ICEGATE requires IEC', async () => {
        const d = indiaDecl(); delete d.importer.iec;
        await assert.rejects(india.submit(d), (e) => e.kind === schema.FAILURE_KIND.VALIDATION && e.messages.some((m) => m.code === 'IN_MISSING_IEC'));
    });
    await t('ACE requires importer id + 8-digit HTS', async () => {
        const d = usDecl(); d.line_items[0].hs_code = '8471'; // too short
        await assert.rejects(us.submit(d), (e) => e.kind === schema.FAILURE_KIND.VALIDATION && e.messages.some((m) => m.code === 'US_SHORT_HTS'));
    });
    await t('CDS requires EORI', async () => {
        const d = euDecl(); delete d.declarant; delete d.importer.eori;
        await assert.rejects(eu.submit(d), (e) => e.kind === schema.FAILURE_KIND.VALIDATION && e.messages.some((m) => m.code === 'EU_MISSING_EORI'));
    });
    await t('Mirsal requires business code / TRN', async () => {
        const d = uaeDecl(); delete d.importer.tax_id;
        await assert.rejects(uae.submit(d), (e) => e.kind === schema.FAILURE_KIND.VALIDATION && e.messages.some((m) => m.code === 'AE_MISSING_BUSINESS_CODE'));
    });

    // ── happy-path submission + response normalization ────────────────────────
    section('submission + normalization');
    await t('ICEGATE accepts → normalized accepted with BE reference', async () => {
        const { normalized, attempts } = await india.submit(indiaDecl());
        assert.strictEqual(normalized.channel, 'icegate');
        assert.strictEqual(normalized.status, schema.STATUS.ACCEPTED);
        assert.strictEqual(normalized.accepted, true);
        assert.ok(/^BE/.test(normalized.gateway_reference));
        assert.strictEqual(normalized.gateway_status, 'REGISTERED');
        assert.strictEqual(attempts, 1);
    });
    await t('ACE accepts → normalized accepted with entry number', async () => {
        const { normalized } = await us.submit(usDecl());
        assert.strictEqual(normalized.channel, 'ace');
        assert.strictEqual(normalized.accepted, true);
        assert.ok(/^ENT/.test(normalized.gateway_reference));
    });
    await t('CDS accepts → normalized accepted with MRN', async () => {
        const { normalized } = await eu.submit(euDecl());
        assert.strictEqual(normalized.channel, 'eu_cds');
        assert.strictEqual(normalized.accepted, true);
        assert.ok(/^MRN/.test(normalized.gateway_reference));
    });
    await t('Mirsal accepts → normalized accepted with declaration number', async () => {
        const { normalized } = await uae.submit(uaeDecl());
        assert.strictEqual(normalized.channel, 'mirsal');
        assert.strictEqual(normalized.accepted, true);
        assert.ok(/^DXB/.test(normalized.gateway_reference));
    });
    await t('all four gateways normalize to the SAME shape', async () => {
        const keys = ['channel', 'status', 'accepted', 'gateway_reference', 'gateway_status', 'messages', 'retryable', 'received_at', 'raw'];
        for (const [c, d] of [[india, indiaDecl()], [us, usDecl()], [eu, euDecl()], [uae, uaeDecl()]]) {
            const { normalized } = await c.submit(d);
            assert.deepStrictEqual(Object.keys(normalized).sort(), [...keys].sort());
        }
    });
    await t('pending acknowledgement → status submitted, not accepted', async () => {
        const { normalized } = await india.submit(indiaDecl('pending'));
        assert.strictEqual(normalized.status, schema.STATUS.SUBMITTED);
        assert.strictEqual(normalized.accepted, false);
    });

    // ── retry mechanism ───────────────────────────────────────────────────────
    section('retry mechanism');
    await t('flaky gateway succeeds after retrying (3 attempts)', async () => {
        const attemptsSeen = [];
        const c = new IndiaConnector({ sleep: noop, maxAttempts: 3, onAttempt: (a) => attemptsSeen.push(a) });
        const { normalized, attempts } = await c.submit(indiaDecl('flaky:2'));
        assert.strictEqual(attempts, 3);
        assert.deepStrictEqual(attemptsSeen, [1, 2, 3]);
        assert.strictEqual(normalized.accepted, true);
    });
    await t('persistent transient failure exhausts retries then throws transient', async () => {
        const c = new USConnector({ sleep: noop, maxAttempts: 3 });
        let captured = null;
        try { await c.submit(usDecl('transient')); } catch (e) { captured = e; }
        assert.ok(captured, 'expected a throw');
        assert.strictEqual(captured.kind, schema.FAILURE_KIND.TRANSIENT);
    });
    await t('permanent rejection is NOT retried (single attempt)', async () => {
        const attemptsSeen = [];
        const c = new EUConnector({ sleep: noop, maxAttempts: 5, onAttempt: (a) => attemptsSeen.push(a) });
        let captured = null;
        try { await c.submit(euDecl('reject')); } catch (e) { captured = e; }
        assert.ok(captured);
        assert.strictEqual(captured.kind, schema.FAILURE_KIND.PERMANENT);
        assert.deepStrictEqual(attemptsSeen, [1]); // no retry burst
    });
    await t('classifyTransport maps HTTP status to the right kind', () => {
        assert.strictEqual(us.classifyTransport(new Error('x'), { status: 503 }).kind, schema.FAILURE_KIND.TRANSIENT);
        assert.strictEqual(us.classifyTransport(new Error('x'), { status: 429 }).kind, schema.FAILURE_KIND.TRANSIENT);
        assert.strictEqual(us.classifyTransport(new Error('x'), { status: 400 }).kind, schema.FAILURE_KIND.PERMANENT);
        const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
        assert.strictEqual(us.classifyTransport(abort).kind, schema.FAILURE_KIND.TRANSIENT);
    });

    // ── registry ──────────────────────────────────────────────────────────────
    section('registry');
    await t('getConnectorForCountry resolves the right connector', () => {
        assert.ok(registry.getConnectorForCountry('IN') instanceof IndiaConnector);
        assert.ok(registry.getConnectorForCountry('US') instanceof USConnector);
        assert.ok(registry.getConnectorForCountry('NL') instanceof EUConnector);
        assert.ok(registry.getConnectorForCountry('AE') instanceof UAEConnector);
        assert.strictEqual(registry.getConnectorForCountry('CN'), null);
    });
    await t('registry is pluggable — register + reset an override', () => {
        const fake = new USConnector({ gatewayName: 'FAKE' });
        registry.registerConnector(schema.CHANNEL.ACE, fake);
        assert.strictEqual(registry.getConnectorByChannel(schema.CHANNEL.ACE), fake);
        registry.resetConnectors();
        assert.notStrictEqual(registry.getConnectorByChannel(schema.CHANNEL.ACE), fake);
        assert.ok(registry.getConnectorByChannel(schema.CHANNEL.ACE) instanceof USConnector);
    });
    await t('supportedChannels lists all four gateways', () => {
        const chans = registry.supportedChannels().sort();
        assert.deepStrictEqual(chans, ['ace', 'eu_cds', 'icegate', 'mirsal']);
    });

    // ── summary ───────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`customs-gateway.verify — ${pass} passed, ${fail} failed (${pass + fail} total)`);
    if (fail) {
        console.log('\nFailures:');
        failures.forEach((f) => console.log(`  • ${f.name}: ${f.message}`));
        process.exit(1);
    }
    process.exit(0);
})();
