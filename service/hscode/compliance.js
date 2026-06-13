'use strict';
/**
 * HS Code Intelligence Engine — COMPLIANCE FLAGS (Prompt 7).
 *
 * PURE: no DB, no network. Derives the regulatory `compliance_flags` for a
 * resolved HS code + trade direction + country from three layers, lowest →
 * highest specificity:
 *   1. CHAPTER rules        — broad regimes by 2-digit chapter (arms, pharma…).
 *   2. entry.controls       — product-specific signals authored on the HS entry.
 *   3. tariff.restrictions  — the per-country national-line restriction object
 *                             (license / prohibited / controlled / permit …).
 *
 * Flags are de-duplicated by (code, country) keeping the highest severity, and
 * returned worst-first. This is advisory screening to drive review/blocking — it
 * is NOT a substitute for an authoritative denied-party / export-control check.
 */

const db = require('./hsDatabase');
const norm = require('./normalize');
const { complianceFlag, FLAG, SEVERITY, severityRank } = require('./schema');

// Broad chapter-level regimes. `scope`: which direction the control applies to.
const CHAPTER_RULES = Object.freeze({
    28: [{ code: FLAG.PERMIT_REQUIRED, severity: SEVERITY.MEDIUM, scope: 'both', message: 'Inorganic chemicals (Ch.28) — hazardous/precursor controls may apply' }],
    29: [{ code: FLAG.PERMIT_REQUIRED, severity: SEVERITY.MEDIUM, scope: 'both', message: 'Organic chemicals (Ch.29) — hazardous/precursor controls may apply' }],
    30: [{ code: FLAG.LICENSE_REQUIRED, severity: SEVERITY.HIGH, scope: 'both', requires: 'Drug regulatory licence', message: 'Pharmaceuticals (Ch.30) — drug regulatory licence required' }],
    36: [{ code: FLAG.EXPORT_CONTROLLED, severity: SEVERITY.HIGH, scope: 'both', message: 'Explosives/pyrotechnics (Ch.36) — controlled goods' }],
    71: [{ code: FLAG.SANCTIONS_SENSITIVE, severity: SEVERITY.MEDIUM, scope: 'both', message: 'Precious metals/stones (Ch.71) — AML & sanctions screening advised' }],
    93: [{ code: FLAG.EXPORT_CONTROLLED, severity: SEVERITY.CRITICAL, scope: 'both', requires: 'Arms export authorisation', message: 'Arms & ammunition (Ch.93) — strategic/controlled goods' }],
    97: [{ code: FLAG.IMPORT_RESTRICTED, severity: SEVERITY.MEDIUM, scope: 'both', message: 'Works of art/antiques (Ch.97) — cultural-property controls may apply' }],
});

// Map a restriction-object key → a flag template.
const RESTRICTION_FLAGS = Object.freeze({
    prohibited: { code: FLAG.PROHIBITED, severity: SEVERITY.CRITICAL, message: 'National tariff line marks this item as prohibited' },
    license: { code: FLAG.LICENSE_REQUIRED, severity: SEVERITY.HIGH, message: 'Import/export licence required for this national line' },
    controlled: { code: FLAG.EXPORT_CONTROLLED, severity: SEVERITY.HIGH, message: 'Item is on a national control list' },
    dual_use: { code: FLAG.DUAL_USE, severity: SEVERITY.HIGH, message: 'Dual-use item — strategic-goods screening required' },
    permit: { code: FLAG.PERMIT_REQUIRED, severity: SEVERITY.MEDIUM, message: 'Permit required for this national line' },
    inspection: { code: FLAG.INSPECTION_REQUIRED, severity: SEVERITY.MEDIUM, message: 'Mandatory inspection for this national line' },
});

/** True when a control's scope applies to the requested direction. */
function scopeApplies(scope, direction) {
    if (!scope || scope === 'both') return true;
    return scope === direction;
}

/**
 * Evaluate compliance flags for a code.
 *
 * @param {object} input
 * @param {string} input.hsCode
 * @param {string} [input.country]            destination/applicable country (ISO-2)
 * @param {('import'|'export'|'both')} [input.direction='both']
 * @returns {object[]} compliance flags, worst-first
 */
function evaluate({ hsCode, country = null, direction = 'both' } = {}) {
    const entry = db.findByCode(hsCode);
    const iso = norm.normalizeCountry(country);
    const flags = [];

    if (!entry) {
        flags.push(complianceFlag({
            code: FLAG.UNCLASSIFIED_PRODUCT, severity: SEVERITY.MEDIUM, hs_code: hsCode, country: iso,
            message: 'HS code is not present in the reference database — manual customs classification required',
            source: 'engine',
        }));
        return flags;
    }

    // 1. Chapter-level regimes.
    const chapterRules = CHAPTER_RULES[Number(entry.chapter)] || [];
    for (const r of chapterRules) {
        if (!scopeApplies(r.scope, direction)) continue;
        flags.push(complianceFlag({
            code: r.code, severity: r.severity, hs_code: entry.hs_code, country: iso,
            requires: r.requires || null, message: r.message, source: 'chapter',
        }));
    }

    // 2. Product-specific controls authored on the entry.
    for (const c of entry.controls || []) {
        if (!scopeApplies(c.scope, direction)) continue;
        flags.push(complianceFlag({
            code: c.code, severity: c.severity || SEVERITY.MEDIUM, hs_code: entry.hs_code, country: iso,
            requires: c.requires || null, message: c.message, source: 'chapter',
        }));
    }

    // 3. Per-country national-line restrictions.
    const line = iso ? db.tariffLine(entry, iso) : null;
    if (iso && !line) {
        flags.push(complianceFlag({
            code: FLAG.NO_TARIFF_LINE, severity: SEVERITY.LOW, hs_code: entry.hs_code, country: iso,
            message: `No national tariff line on record for ${iso} — confirm classification with local customs`,
            source: 'engine',
        }));
    }
    if (line && line.restrictions) {
        for (const [key, value] of Object.entries(line.restrictions)) {
            const tmpl = RESTRICTION_FLAGS[key];
            if (!tmpl || !value) continue;
            const requires = typeof value === 'string' ? value : tmpl.requires || null;
            flags.push(complianceFlag({
                code: tmpl.code, severity: tmpl.severity, hs_code: entry.hs_code, country: iso,
                requires, message: typeof value === 'string' ? `${tmpl.message}: ${value}` : tmpl.message,
                source: 'tariff',
            }));
        }
    }

    return dedupe(flags);
}

/** De-duplicate by (code, country), keeping the highest-severity instance. */
function dedupe(flags) {
    const best = new Map();
    for (const f of flags) {
        const key = `${f.code}|${f.country || ''}`;
        const cur = best.get(key);
        if (!cur || severityRank(f.severity) > severityRank(cur.severity)) best.set(key, f);
    }
    return [...best.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

/** True when any flag is severe enough to block clearance without action. */
function isBlocking(flags) {
    return flags.some((f) => f.code === FLAG.PROHIBITED
        || (f.severity === SEVERITY.CRITICAL)
        || f.code === FLAG.LICENSE_REQUIRED
        || f.code === FLAG.EXPORT_CONTROLLED);
}

module.exports = {
    evaluate,
    isBlocking,
    dedupe,
    CHAPTER_RULES,
    RESTRICTION_FLAGS,
};
