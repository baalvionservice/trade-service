'use strict';
/**
 * Compliance & Sanctions Engine — RULES ENGINE (War Room 4, Prompt 8).
 *
 * PURE: no DB, no I/O, no clock. Given a normalized screening subject + the
 * reference data (sanctioned parties, controlled goods, trade bans) + the
 * tenant's blacklist/whitelist overrides, it deterministically emits the full set
 * of `violation` records. The severity scorer + report builder consume that set —
 * this module decides WHAT is wrong, not how bad the overall picture is.
 *
 * The seven checks the prompt asks for:
 *   1. sanctioned countries  — origin / destination / any party country
 *   2. sanctioned parties    — buyer / seller / shipper / consignee names
 *   3. restricted goods      — controlled goods, control_type = restricted
 *   4. dual-use goods        — controlled goods, control_type = dual_use
 *      (+ prohibited goods   — control_type = prohibited, a hard stop)
 *   5. export / import bans  — country-specific trade bans (direction-aware)
 *   6. blacklist             — tenant DENY overrides
 *   7. whitelist             — tenant ALLOW overrides (de-escalate, never block)
 *
 * KYC/AML are NOT here — they are async hooks (kycAml.js) the orchestrator runs,
 * because they call out to an identity/transaction-risk provider.
 */

const { CHECK, SEVERITY, violation } = require('./schema');
const norm = require('./normalize');

const CONTROL_TYPE_TO_CHECK = Object.freeze({
    restricted: CHECK.RESTRICTED_GOODS,
    dual_use: CHECK.DUAL_USE_GOODS,
    prohibited: CHECK.PROHIBITED_GOODS,
});

/** Collect every distinct, normalized country implicated in the subject. */
function subjectCountries(subject) {
    const set = new Set();
    const add = (c) => { const n = norm.normalizeCountry(c); if (n) set.add(n); };
    add(subject.originCountry);
    add(subject.destinationCountry);
    for (const p of subject.parties || []) add(p.country);
    return [...set];
}

/** 1. Sanctioned countries — any implicated country on the sanctioned list. */
function checkSanctionedCountries(subject, sanctionedCountries, out) {
    const byCode = new Map();
    for (const s of sanctionedCountries) {
        if (s.country) byCode.set(String(s.country).toUpperCase(), s);
    }
    for (const country of subjectCountries(subject)) {
        const hit = byCode.get(country);
        if (!hit) continue;
        // Which role does this country play in the transaction?
        const roles = [];
        if (norm.normalizeCountry(subject.originCountry) === country) roles.push('origin');
        if (norm.normalizeCountry(subject.destinationCountry) === country) roles.push('destination');
        out.push(violation({
            check: CHECK.SANCTIONED_COUNTRY,
            code: 'SANCTIONED_COUNTRY_MATCH',
            severity: hit.severity || SEVERITY.HIGH,
            subject: country,
            message: `${hit.name || country} is under ${hit.program || 'sanctions'} (${hit.list_source || 'list'})`,
            details: { country, program: hit.program, list_source: hit.list_source, roles },
        }));
    }
}

/** 2. Sanctioned parties — any party name matching a listed restricted party. */
function checkSanctionedParties(subject, namedParties, out) {
    for (const party of subject.parties || []) {
        if (norm.isBlank(party.name)) continue;
        for (const listed of namedParties) {
            if (!norm.nameMatches(party.name, listed.name, listed.aliases)) continue;
            out.push(violation({
                check: CHECK.SANCTIONED_PARTY,
                code: 'SANCTIONED_PARTY_MATCH',
                severity: listed.severity || SEVERITY.CRITICAL,
                subject: party.name,
                message: `Party "${party.name}"${party.role ? ` (${party.role})` : ''} matches listed party "${listed.name}" — ${listed.program || 'restricted party'}`,
                details: { matched: listed.name, role: party.role || null, party_type: listed.party_type, program: listed.program, list_source: listed.list_source },
            }));
            break; // one violation per party is enough
        }
    }
}

/** 3+4. Controlled goods — restricted / dual-use / prohibited (HS or keyword). */
function checkControlledGoods(subject, controlledGoods, out) {
    for (const good of subject.goods || []) {
        for (const ctrl of controlledGoods) {
            const byHs = norm.hsPrefixMatches(good.hsCode, ctrl.hs_prefixes);
            const byKw = !byHs && norm.keywordMatches(good.description, ctrl.keywords);
            if (!byHs && !byKw) continue;
            out.push(violation({
                check: CONTROL_TYPE_TO_CHECK[ctrl.control_type] || CHECK.RESTRICTED_GOODS,
                code: `${String(ctrl.control_type).toUpperCase()}_GOODS_MATCH`,
                severity: ctrl.severity || SEVERITY.HIGH,
                subject: good.description || good.hsCode || ctrl.code,
                message: `Goods "${good.description || good.hsCode}" classified ${ctrl.control_type} (${ctrl.category}) — ${ctrl.regimes && ctrl.regimes.length ? ctrl.regimes.join('/') : 'export-controlled'}`,
                details: {
                    control_code: ctrl.code, control_type: ctrl.control_type, category: ctrl.category,
                    matched_on: byHs ? 'hs_prefix' : 'keyword', regimes: ctrl.regimes || [],
                    license_required: ctrl.license_required !== false,
                },
            }));
            break; // first (most specific) control wins per good
        }
    }
}

/** 5. Export / import bans — country-specific, direction-aware. */
function checkTradeBans(subject, tradeBans, out) {
    const origin = norm.normalizeCountry(subject.originCountry);
    const destination = norm.normalizeCountry(subject.destinationCountry);
    const goods = subject.goods || [];

    for (const ban of tradeBans) {
        const cp = String(ban.counterparty_country || '*').toUpperCase();
        // Does the transaction touch the embargoed counterparty in a banned direction?
        const exportHit = (ban.direction === 'export' || ban.direction === 'both') && cp === destination;
        const importHit = (ban.direction === 'import' || ban.direction === 'both') && cp === origin;
        const anyHit = cp === '*' ? (!!origin || !!destination) : (exportHit || importHit);
        if (!anyHit) continue;

        // Goods scope: '*' category + empty hs_prefixes → all goods. Otherwise the
        // ban only bites when at least one good matches its category/HS scope.
        const scoped = ban.category === '*' && (!ban.hs_prefixes || ban.hs_prefixes.length === 0);
        let matchedGood = null;
        if (!scoped) {
            matchedGood = goods.find((g) =>
                (ban.category !== '*' && g.category && String(g.category).toLowerCase() === String(ban.category).toLowerCase())
                || norm.hsPrefixMatches(g.hsCode, ban.hs_prefixes || []));
            if (!matchedGood) continue;
        }

        const direction = exportHit && !importHit ? 'export' : importHit && !exportHit ? 'import' : 'both';
        out.push(violation({
            check: CHECK.TRADE_BAN,
            code: 'TRADE_BAN_MATCH',
            severity: ban.severity || SEVERITY.CRITICAL,
            subject: cp === '*' ? (destination || origin) : cp,
            message: `${ban.description || 'Trade ban'} (${ban.jurisdiction || 'GLOBAL'} ${ban.direction})`,
            details: {
                ban_code: ban.code, jurisdiction: ban.jurisdiction, direction, counterparty_country: cp,
                category: ban.category, matched_good: matchedGood ? (matchedGood.description || matchedGood.hsCode) : null,
            },
        }));
    }
}

/** 6. Tenant blacklist — DENY overrides across party / country / good / hs_code. */
function checkBlacklist(subject, blacklist, out) {
    if (!Array.isArray(blacklist) || blacklist.length === 0) return;
    const countries = new Set(subjectCountries(subject));
    for (const entry of blacklist) {
        const value = entry.value;
        if (norm.isBlank(value)) continue;
        let matched = false;
        let subjectLabel = value;
        switch (entry.subject_type) {
            case 'country': {
                const c = norm.normalizeCountry(value);
                if (c && countries.has(c)) { matched = true; subjectLabel = c; }
                break;
            }
            case 'party':
            case 'entity': {
                const p = (subject.parties || []).find((x) => norm.nameMatches(x.name, value, []));
                if (p) { matched = true; subjectLabel = p.name; }
                break;
            }
            case 'hs_code': {
                const g = (subject.goods || []).find((x) => norm.hsPrefixMatches(x.hsCode, [value]));
                if (g) { matched = true; subjectLabel = g.hsCode; }
                break;
            }
            case 'good': {
                const g = (subject.goods || []).find((x) => norm.keywordMatches(x.description, [value]));
                if (g) { matched = true; subjectLabel = g.description; }
                break;
            }
            default:
                break;
        }
        if (!matched) continue;
        out.push(violation({
            check: CHECK.BLACKLIST,
            code: 'TENANT_BLACKLIST_MATCH',
            severity: entry.severity || SEVERITY.HIGH,
            subject: subjectLabel,
            message: `Tenant blacklist: ${entry.subject_type} "${subjectLabel}"${entry.reason ? ` — ${entry.reason}` : ''}`,
            details: { subject_type: entry.subject_type, value, reason: entry.reason || null },
        }));
    }
}

/**
 * 7. Tenant whitelist — de-escalate matching violations to informational so a
 * tenant's explicit ALLOW can never block their own trade. The violation stays
 * in the record (auditable) but is marked `whitelisted` and severity → none.
 */
function applyWhitelist(violations, whitelist, subject) {
    if (!Array.isArray(whitelist) || whitelist.length === 0) return violations;
    const wlCountries = new Set();
    const wlNames = [];
    const wlHs = [];
    const wlGoods = [];
    for (const w of whitelist) {
        if (norm.isBlank(w.value)) continue;
        if (w.subject_type === 'country') { const c = norm.normalizeCountry(w.value); if (c) wlCountries.add(c); }
        else if (w.subject_type === 'party' || w.subject_type === 'entity') wlNames.push(w.value);
        else if (w.subject_type === 'hs_code') wlHs.push(w.value);
        else if (w.subject_type === 'good') wlGoods.push(w.value);
    }

    const isWhitelisted = (v) => {
        const subj = v.subject || '';
        // Country-bearing checks: subject is (or details carry) a country code.
        const detailCountry = v.details && (v.details.country || v.details.counterparty_country);
        if (detailCountry && wlCountries.has(String(detailCountry).toUpperCase())) return true;
        if (wlCountries.has(norm.normalizeCountry(subj))) return true;
        if (wlNames.some((n) => norm.nameMatches(subj, n, []))) return true;
        if (wlHs.some((h) => norm.hsPrefixMatches(subj, [h]) || norm.hsPrefixMatches(v.details && v.details.hs_code, [h]))) return true;
        if (wlGoods.some((g) => norm.keywordMatches(subj, [g]))) return true;
        return false;
    };

    return violations.map((v) => {
        // A tenant whitelist is a convenience for de-escalating LOWER-RISK, normally-
        // flagged findings (a restricted/dual-use good, a sectoral ban) — it must
        // NEVER let a tenant self-clear a hard sanctions hit. Protected from
        // whitelisting, regardless of any matching whitelist entry:
        //   • PROHIBITED_GOODS — globally prohibited (CWC agents, narcotics).
        //   • BLACKLIST        — a deny the tenant itself set.
        //   • SANCTIONED_PARTY — a named restricted party (SDN-style).
        //   • any CRITICAL-severity violation — e.g. a comprehensive-embargo
        //     SANCTIONED_COUNTRY or a critical TRADE_BAN.
        if (
            v.check === CHECK.PROHIBITED_GOODS
            || v.check === CHECK.BLACKLIST
            || v.check === CHECK.SANCTIONED_PARTY
            || v.severity === SEVERITY.CRITICAL
        ) return v;
        if (!isWhitelisted(v)) return v;
        return {
            ...v,
            whitelisted: true,
            original_severity: v.severity,
            severity: SEVERITY.NONE,
            message: `${v.message} [whitelisted by tenant]`,
        };
    });
}

/**
 * Run every check and return the violation set + a per-check execution summary.
 *
 * @param {object} subject  normalized screening subject
 *   { originCountry, destinationCountry, parties:[{name,role,country,type}],
 *     goods:[{description,hsCode,category,value}] }
 * @param {object} refData  { sanctionedCountries, namedParties, controlledGoods, tradeBans }
 * @param {object} [tenantLists]  { blacklist:[...], whitelist:[...] }
 * @returns {{ violations: object[], checks: object }}
 */
function run(subject, refData, tenantLists = {}) {
    const ref = refData || {};
    const out = [];

    checkSanctionedCountries(subject, ref.sanctionedCountries || [], out);
    checkSanctionedParties(subject, ref.namedParties || [], out);
    checkControlledGoods(subject, ref.controlledGoods || [], out);
    checkTradeBans(subject, ref.tradeBans || [], out);
    checkBlacklist(subject, tenantLists.blacklist || [], out);

    const violations = applyWhitelist(out, tenantLists.whitelist || [], subject);

    // Per-check execution summary (which checks ran, how many hit).
    const checks = {};
    for (const key of Object.values(CHECK)) {
        if (key === CHECK.KYC || key === CHECK.AML || key === CHECK.WHITELIST) continue;
        checks[key] = { ran: true, matched: violations.filter((v) => v.check === key).length };
    }
    checks[CHECK.WHITELIST] = { ran: (tenantLists.whitelist || []).length > 0, applied: violations.filter((v) => v.whitelisted).length };

    return { violations, checks };
}

module.exports = {
    run,
    subjectCountries,
    checkSanctionedCountries,
    checkSanctionedParties,
    checkControlledGoods,
    checkTradeBans,
    checkBlacklist,
    applyWhitelist,
    CONTROL_TYPE_TO_CHECK,
};
