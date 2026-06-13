'use strict';
/**
 * Compliance AI Agent — SHIPMENT SCANNER / SIGNAL EXTRACTION (Prompt 13).
 *
 * PURE: no DB, no I/O, no clock-of-its-own (callers inject `now`). This is the
 * agent's "scan" phase: it reads a raw shipment (+ its trade operation, parties
 * and goods) and distils it into:
 *
 *   • subject  — the canonical screening subject both analyzers consume (the SAME
 *                shape the Prompt 8 rules engine expects, so the rule layer can be
 *                reused verbatim), and
 *   • signals  — the derived, human-readable observations the AI layer reasons
 *                over and the explainer narrates (jurisdictions touched, declared
 *                value, route legs, data-completeness gaps, status flags).
 *
 * Keeping extraction in ONE pure place means the rule layer, the AI layer and the
 * explainability output all reason about exactly the same scanned facts.
 */

const norm = require('../compliance/normalize');

const HIGH_VALUE_THRESHOLD = 100000;       // declared value worth an AML second look
const VAGUE_DESCRIPTION_MAX_WORDS = 2;     // a 1–2 word goods description is thin
const VAGUE_TERMS = Object.freeze([
    'goods', 'parts', 'equipment', 'materials', 'samples', 'items',
    'merchandise', 'products', 'spare parts', 'machinery', 'components',
    'general cargo', 'consolidated', 'gift', 'used goods', 'personal effects',
]);

/** Best-effort numeric coercion (null when not a finite number). */
function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Normalize a loose party shape into { name, role, country, type }. */
function normParty(p) {
    if (!p) return null;
    if (typeof p === 'string') return { name: p, role: null, country: null, type: 'entity' };
    return {
        name: p.name != null ? String(p.name) : null,
        role: p.role != null ? String(p.role) : null,
        country: norm.normalizeCountry(p.country),
        type: p.type || p.party_type || 'entity',
    };
}

/** Normalize a loose good shape into { description, hsCode, category, value }. */
function normGood(g) {
    if (!g) return null;
    if (typeof g === 'string') return { description: g, hsCode: null, category: null, value: null };
    return {
        description: g.description != null ? String(g.description) : null,
        hsCode: g.hsCode != null ? String(g.hsCode) : (g.hs_code != null ? String(g.hs_code) : null),
        category: g.category != null ? String(g.category) : null,
        value: num(g.value),
    };
}

/**
 * Assemble the canonical screening subject from a scanned shipment + operation.
 * Mirrors the Prompt 8 engine's subjectFromOperation, but shipment-first: a
 * shipment carries origin/destination/value directly and may name parties/goods
 * in its metadata; the operation backfills anything the shipment omits.
 */
function buildSubject({ shipment = {}, operation = {}, overrides = {} } = {}) {
    const s = shipment || {};
    const op = operation || {};
    const sMeta = s.metadata || {};
    const opMeta = op.metadata || {};

    // Parties: prefer explicit overrides → shipment metadata → operation metadata
    // → derived from the operation's buyer/seller orgs.
    let parties = overrides.parties
        || (Array.isArray(sMeta.parties) && sMeta.parties.length ? sMeta.parties : null)
        || (Array.isArray(opMeta.parties) && opMeta.parties.length ? opMeta.parties : null);
    if (!parties) {
        parties = [];
        if (op.seller_org_id) parties.push({ name: op.seller_org_id, role: 'seller', country: s.origin_country || op.origin_country });
        if (op.buyer_org_id) parties.push({ name: op.buyer_org_id, role: 'buyer', country: s.destination_country || op.destination_country });
    }

    // Goods: prefer overrides → shipment metadata → operation metadata → derived.
    let goods = overrides.goods
        || (Array.isArray(sMeta.goods) && sMeta.goods.length ? sMeta.goods : null)
        || (Array.isArray(opMeta.goods) && opMeta.goods.length ? opMeta.goods : null);
    if (!goods) {
        goods = [];
        if (op.commodity || op.hs_code) {
            goods.push({
                description: op.commodity || null,
                hsCode: op.hs_code || null,
                category: opMeta.category || null,
                value: num(op.total_value),
            });
        }
    }

    const originCountry = norm.normalizeCountry(overrides.originCountry || s.origin_country || op.origin_country);
    const destinationCountry = norm.normalizeCountry(overrides.destinationCountry || s.destination_country || op.destination_country);

    return {
        originCountry,
        destinationCountry,
        direction: overrides.direction || opMeta.direction || 'both',
        totalValue: overrides.totalValue != null ? num(overrides.totalValue)
            : (num(s.declared_value) != null ? num(s.declared_value) : num(op.total_value)),
        currency: overrides.currency || s.currency || op.currency || null,
        parties: parties.map(normParty).filter(Boolean),
        goods: goods.map(normGood).filter(Boolean),
        // Carry the route legs (transit countries) the AI layer reasons over.
        route: Array.isArray(overrides.route) ? overrides.route
            : (Array.isArray(sMeta.route) ? sMeta.route : (Array.isArray(sMeta.transit_countries) ? sMeta.transit_countries : [])),
    };
}

/** Every distinct, normalized country implicated anywhere in the subject. */
function implicatedCountries(subject) {
    const set = new Set();
    const add = (c) => { const n = norm.normalizeCountry(c); if (n) set.add(n); };
    add(subject.originCountry);
    add(subject.destinationCountry);
    for (const p of subject.parties || []) add(p.country);
    for (const leg of subject.route || []) add(typeof leg === 'string' ? leg : (leg && leg.country));
    return [...set];
}

/** Normalized transit (route) countries that are NOT the origin/destination. */
function transitCountries(subject) {
    const endpoints = new Set([
        norm.normalizeCountry(subject.originCountry),
        norm.normalizeCountry(subject.destinationCountry),
    ].filter(Boolean));
    const out = [];
    for (const leg of subject.route || []) {
        const c = norm.normalizeCountry(typeof leg === 'string' ? leg : (leg && leg.country));
        if (c && !endpoints.has(c) && !out.includes(c)) out.push(c);
    }
    return out;
}

/** Is this goods description thin / evasive (a misclassification risk signal)? */
function isVagueDescription(description) {
    if (norm.isBlank(description)) return true;
    const text = norm.cleanText(description);
    if (VAGUE_TERMS.includes(text)) return true;
    const words = text.split(' ').filter(Boolean);
    if (words.length <= VAGUE_DESCRIPTION_MAX_WORDS && VAGUE_TERMS.some((t) => text.includes(t))) return true;
    return false;
}

/**
 * Scan a shipment into the agent's working facts.
 *
 * @returns {{ subject, signals }} where signals is a flat, narratable fact list:
 *   { code, label, value?, weight? } — weight is an informational 0..1 hint of how
 *   risk-relevant the signal is (the AI layer assigns the actual scores).
 */
function scan({ shipment = {}, operation = {}, overrides = {}, now = new Date() } = {}) {
    const subject = buildSubject({ shipment, operation, overrides });
    const signals = [];
    const add = (code, label, extra = {}) => signals.push({ code, label, ...extra });

    const countries = implicatedCountries(subject);
    const transit = transitCountries(subject);
    add('countries', `${countries.length} jurisdiction(s) implicated`, { value: countries });
    if (subject.originCountry) add('origin', `origin ${subject.originCountry}`, { value: subject.originCountry });
    if (subject.destinationCountry) add('destination', `destination ${subject.destinationCountry}`, { value: subject.destinationCountry });
    if (transit.length) add('transit', `${transit.length} transit leg(s): ${transit.join(', ')}`, { value: transit, weight: 0.4 });

    // Value signals.
    const value = subject.totalValue;
    if (value != null) {
        add('declared_value', `declared value ${value}${subject.currency ? ' ' + subject.currency : ''}`, { value });
        if (value >= HIGH_VALUE_THRESHOLD) add('high_value', `high declared value (≥ ${HIGH_VALUE_THRESHOLD})`, { value, weight: 0.4 });
        // A suspiciously round large number is a classic valuation red flag.
        if (value >= 10000 && value % 10000 === 0) add('round_value', 'declared value is a round figure', { value, weight: 0.2 });
    } else {
        add('value_missing', 'no declared value supplied', { weight: 0.3 });
    }

    // Party completeness signals (identity / KYC data gaps).
    const parties = subject.parties || [];
    add('party_count', `${parties.length} counterparty(ies)`, { value: parties.length });
    if (parties.length === 0) add('no_parties', 'no counterparties supplied', { weight: 0.5 });
    for (const p of parties) {
        if (norm.isBlank(p.name)) add('party_no_name', `a ${p.role || 'party'} has no name`, { weight: 0.4 });
        else if (norm.isBlank(p.country)) add('party_no_country', `party "${p.name}" has no country`, { value: p.name, weight: 0.3 });
    }

    // Goods completeness + description-quality signals.
    const goods = subject.goods || [];
    add('goods_count', `${goods.length} goods line(s)`, { value: goods.length });
    if (goods.length === 0) add('no_goods', 'no goods described', { weight: 0.3 });
    for (const g of goods) {
        if (norm.isBlank(g.hsCode)) add('goods_no_hs', `goods "${g.description || 'unnamed'}" has no HS code`, { value: g.description, weight: 0.25 });
        if (isVagueDescription(g.description)) add('goods_vague', `goods description is vague/evasive: "${g.description || '(blank)'}"`, { value: g.description, weight: 0.35 });
    }

    // Shipment status flags (a held/exception shipment is itself a risk context).
    if (shipment && shipment.status) {
        add('status', `shipment status ${shipment.status}`, { value: shipment.status });
        if (['customs_hold', 'exception'].includes(shipment.status)) add('status_flagged', `shipment is in a flagged status (${shipment.status})`, { value: shipment.status, weight: 0.3 });
    }

    return {
        subject,
        signals,
        scanned_countries: countries,
        transit_countries: transit,
        scanned_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    };
}

module.exports = {
    scan,
    buildSubject,
    implicatedCountries,
    transitCountries,
    isVagueDescription,
    normParty,
    normGood,
    HIGH_VALUE_THRESHOLD,
    VAGUE_TERMS,
};
