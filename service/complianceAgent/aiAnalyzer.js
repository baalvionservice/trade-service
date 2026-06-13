'use strict';
/**
 * Compliance AI Agent — AI RISK-INFERENCE LAYER (Prompt 13).
 *
 * The PROBABILISTIC half of the hybrid: the risks a flat rules engine cannot see
 * — elevated-jurisdiction nexus, transshipment / route anomalies, valuation
 * anomalies, evasive goods descriptions, identity/data gaps and AML behavioural
 * patterns. Each inference carries a CONFIDENCE (how sure the model is) and a
 * RATIONALE (its reasoning), so the agent can explain itself.
 *
 * PLUGGABLE by design (mirrors hscode/aiSuggester + compliance/kycAml): the
 * default provider is a deterministic, network-free HEURISTIC so the agent works
 * offline and tests are reproducible. A real model — Claude, a fine-tuned trade-
 * risk classifier, a vendor screening API — is dropped in with `registerProvider()`
 * WITHOUT touching the rules layer, fusion, explainability or persistence.
 *
 * A provider MUST implement:
 *   {
 *     name: string,
 *     async analyze({ subject, signals, context }) => {
 *       findings:  finding[]   // schema.finding(..., source:'ai')
 *       reasoning?: string     // optional human-readable rationale
 *     }
 *   }
 *
 * The engine always normalizes/clamps a provider's output (re-stamping source as
 * `ai`, clamping confidence, dropping malformed findings) so a misbehaving plug-in
 * can never crash an assessment — at worst it degrades to no AI findings.
 */

const norm = require('../compliance/normalize');
const {
    finding, SOURCE, RISK_CATEGORY, SEVERITY, clampConfidence, ALL_CATEGORIES,
} = require('./schema');
const { transitCountries, isVagueDescription, HIGH_VALUE_THRESHOLD } = require('./signals');

// Elevated-risk jurisdictions (FATF-style illustrative list; a real model uses a
// maintained risk feed). Shared shape with compliance/kycAml's high-risk set.
const HIGH_RISK_COUNTRIES = Object.freeze(new Set(['IR', 'KP', 'SY', 'RU', 'BY', 'VE', 'MM', 'CU', 'AF', 'SD', 'SS', 'YE', 'ZW']));
// Common transshipment / re-export hubs — a leg through one of these toward a
// high-risk destination is a classic diversion pattern.
const TRANSSHIPMENT_HUBS = Object.freeze(new Set(['AE', 'HK', 'SG', 'MY', 'TR', 'GE', 'AM', 'KZ']));

// Coarse expected unit-value bands (USD-ish, any currency best-effort) per goods
// category. Used ONLY to flag an order-of-magnitude valuation anomaly, never to
// price anything. Deliberately wide.
const CATEGORY_VALUE_BAND = Object.freeze({
    electronics: [50, 5000],
    pharmaceuticals: [5, 2000],
    chemicals: [10, 5000],
    metals: [100, 100000],
    machinery: [500, 500000],
    vehicles: [2000, 500000],
    textiles: [2, 500],
    agriculture: [1, 1000],
});

// Dual-use / sensitive SEMANTIC cues a keyword list on the control DB may miss —
// the AI layer surfaces these as a soft misclassification/diversion signal even
// when the rules engine found nothing.
const SENSITIVE_CUES = Object.freeze([
    'centrifuge', 'enrichment', 'maraging', 'gyroscope', 'accelerometer',
    'uav', 'drone', 'night vision', 'thermal imaging', 'encryption',
    'precursor', 'reagent grade', 'high purity', 'aerospace grade',
    'carbon fiber', 'numerically controlled', 'cnc', 'spectrometer',
]);

const round = (n) => Math.round(n);

function partyCountries(subject) {
    const set = new Set();
    const add = (c) => { const n = norm.normalizeCountry(c); if (n) set.add(n); };
    add(subject.originCountry);
    add(subject.destinationCountry);
    for (const p of subject.parties || []) add(p.country);
    return [...set];
}

// ── Individual heuristic detectors. Each returns a finding (or null). ─────────

/** Elevated-risk jurisdiction nexus (origin / destination / any party country). */
function detectJurisdictionRisk(subject) {
    const hits = partyCountries(subject).filter((c) => HIGH_RISK_COUNTRIES.has(c));
    if (!hits.length) return null;
    const confidence = clampConfidence(60 + hits.length * 8);
    return finding({
        category: RISK_CATEGORY.JURISDICTION_RISK,
        source: SOURCE.AI,
        severity: hits.length > 1 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        confidence,
        title: 'Elevated-risk jurisdiction nexus',
        subject: hits.join(', '),
        rationale: `The transaction touches ${hits.length} elevated-risk jurisdiction(s) (${hits.join(', ')}), which raises the base-rate likelihood of sanctions exposure and diversion even absent a direct list match.`,
        evidence: hits.map((c) => `high_risk_jurisdiction:${c}`),
        recommendation: 'Apply enhanced due diligence on the counterparties and end-use in this jurisdiction.',
        refs: { jurisdictions: hits },
    });
}

/** Transshipment / implausible-route anomaly toward a high-risk destination. */
function detectRouteAnomaly(subject) {
    const transit = transitCountries(subject);
    if (!transit.length) return null;
    const dest = norm.normalizeCountry(subject.destinationCountry);
    const hubLegs = transit.filter((c) => TRANSSHIPMENT_HUBS.has(c));
    const riskyLegs = transit.filter((c) => HIGH_RISK_COUNTRIES.has(c));
    const destHighRisk = dest && HIGH_RISK_COUNTRIES.has(dest);

    if (!hubLegs.length && !riskyLegs.length) return null;
    let severity = SEVERITY.LOW;
    let confidence = 52;
    const evidence = transit.map((c) => `transit:${c}`);
    const reasons = [];
    if (riskyLegs.length) { severity = SEVERITY.HIGH; confidence = 72; reasons.push(`routed through elevated-risk territory (${riskyLegs.join(', ')})`); }
    if (hubLegs.length && (destHighRisk || riskyLegs.length)) { severity = SEVERITY.MEDIUM; confidence = Math.max(confidence, 66); reasons.push(`re-export hub leg(s) (${hubLegs.join(', ')}) toward a sensitive destination`); }
    else if (hubLegs.length) { reasons.push(`re-export hub leg(s) (${hubLegs.join(', ')})`); }

    return finding({
        category: RISK_CATEGORY.ROUTE_ANOMALY,
        source: SOURCE.AI,
        severity,
        confidence: clampConfidence(confidence),
        title: 'Routing / transshipment anomaly',
        subject: transit.join(' → '),
        rationale: `Routing analysis: ${reasons.join('; ')}. Indirect routing through hubs/high-risk legs is a common diversion and sanctions-evasion signature.`,
        evidence,
        recommendation: 'Confirm the commercial rationale for the routing and the ultimate end-user.',
        refs: { transit, hub_legs: hubLegs, risky_legs: riskyLegs, destination: dest },
    });
}

/** Valuation anomaly: declared value far outside the category's expected band. */
function detectValuationAnomaly(subject) {
    const goods = subject.goods || [];
    if (goods.length === 0) return null;
    // Total is optional: a goods line with its own value can flag an anomaly even
    // when no overall declared value was supplied. When there is exactly one line
    // and no line value, the overall total is attributed to it.
    const total = Number(subject.totalValue);
    const haveTotal = Number.isFinite(total) && total > 0;

    let worst = null;
    for (const g of goods) {
        const cat = g.category && CATEGORY_VALUE_BAND[String(g.category).toLowerCase()];
        if (!cat) continue;
        const v = Number(g.value) || (goods.length === 1 && haveTotal ? total : null);
        if (!Number.isFinite(v) || v <= 0) continue;
        const [lo, hi] = cat;
        let direction = null;
        if (v < lo / 10) direction = 'under';
        else if (v > hi * 20) direction = 'over';
        if (direction && (!worst || Math.abs(Math.log(v)) > Math.abs(Math.log(worst.v)))) {
            worst = { g, v, lo, hi, direction };
        }
    }
    if (!worst) return null;
    const under = worst.direction === 'under';
    return finding({
        category: RISK_CATEGORY.VALUATION_ANOMALY,
        source: SOURCE.AI,
        severity: under ? SEVERITY.MEDIUM : SEVERITY.LOW,
        confidence: under ? 64 : 56,
        title: `Declared value looks ${under ? 'under' : 'over'}-stated`,
        subject: worst.g.description || worst.g.hsCode || worst.g.category,
        rationale: `Declared value ${round(worst.v)} for category '${worst.g.category}' is ${under ? 'far below' : 'far above'} the expected band (${worst.lo}–${worst.hi}). ${under ? 'Under-valuation can indicate duty evasion or trade-based money laundering.' : 'Over-valuation can indicate value transfer / TBML.'}`,
        evidence: [`category_band:${worst.lo}-${worst.hi}`, `declared:${round(worst.v)}`],
        recommendation: 'Reconcile the declared value against the commercial invoice and market price.',
        refs: { category: worst.g.category, declared: worst.v, band: [worst.lo, worst.hi], direction: worst.direction },
    });
}

/** Evasive/vague goods descriptions + sensitive semantic cues (misclassification). */
function detectGoodsMisclassification(subject) {
    const goods = subject.goods || [];
    const vague = [];
    const cued = [];
    for (const g of goods) {
        const text = norm.cleanText(g.description);
        if (isVagueDescription(g.description)) vague.push(g.description || '(blank)');
        for (const cue of SENSITIVE_CUES) {
            if (text.includes(cue)) { cued.push({ desc: g.description, cue }); break; }
        }
    }
    if (!vague.length && !cued.length) return null;

    if (cued.length) {
        const c = cued[0];
        return finding({
            category: RISK_CATEGORY.GOODS_MISCLASSIFICATION,
            source: SOURCE.AI,
            severity: SEVERITY.HIGH,
            confidence: 70,
            title: 'Goods description carries dual-use / sensitive cues',
            subject: c.desc,
            rationale: `Description "${c.desc}" contains the sensitive term '${c.cue}', associated with dual-use / export-controlled technology, but the deterministic control list did not match it. This may be a misclassification or an under-the-radar controlled item.`,
            evidence: cued.map((x) => `sensitive_cue:${x.cue}`),
            recommendation: 'Have a classification specialist confirm the HS code and export-control status.',
            refs: { cues: cued.map((x) => x.cue) },
        });
    }
    return finding({
        category: RISK_CATEGORY.GOODS_MISCLASSIFICATION,
        source: SOURCE.AI,
        severity: SEVERITY.LOW,
        confidence: 55,
        title: 'Vague / generic goods description',
        subject: vague[0],
        rationale: `${vague.length} goods line(s) use a vague or generic description (e.g. "${vague[0]}"). Thin descriptions defeat classification and screening and are a known evasion tactic.`,
        evidence: vague.slice(0, 5).map((d) => `vague:${d}`),
        recommendation: 'Request a specific, classifiable goods description.',
        refs: { vague_count: vague.length },
    });
}

/** Identity / classification data gaps (KYC-relevant completeness). */
function detectDocumentationGap(subject) {
    const parties = subject.parties || [];
    const gaps = [];
    if (parties.length === 0) gaps.push('no counterparties identified');
    for (const p of parties) {
        if (norm.isBlank(p.name)) gaps.push(`${p.role || 'a party'} has no name`);
        else if (norm.isBlank(p.country)) gaps.push(`party "${p.name}" has no country`);
    }
    const hsMissing = (subject.goods || []).filter((g) => norm.isBlank(g.hsCode)).length;
    if (hsMissing) gaps.push(`${hsMissing} goods line(s) missing an HS code`);
    if (!gaps.length) return null;

    const severe = parties.length === 0 || gaps.some((g) => g.includes('no name'));
    return finding({
        category: RISK_CATEGORY.DOCUMENTATION_GAP,
        source: SOURCE.AI,
        severity: severe ? SEVERITY.MEDIUM : SEVERITY.LOW,
        confidence: clampConfidence(50 + gaps.length * 6),
        title: 'Incomplete identity / classification data',
        subject: `${gaps.length} data gap(s)`,
        rationale: `The shipment is missing data needed to screen it confidently: ${gaps.join('; ')}. Gaps weaken every downstream check and lower the confidence of a 'clear' verdict.`,
        evidence: gaps.slice(0, 6),
        recommendation: 'Collect the missing party and classification data and re-screen.',
        refs: { gaps },
    });
}

/** AML behavioural pattern: high value into / through an elevated-risk jurisdiction. */
function detectAmlPattern(subject) {
    const value = Number(subject.totalValue) || 0;
    const highRisk = partyCountries(subject).filter((c) => HIGH_RISK_COUNTRIES.has(c));
    if (value < HIGH_VALUE_THRESHOLD || !highRisk.length) return null;
    return finding({
        category: RISK_CATEGORY.AML_PATTERN,
        source: SOURCE.AI,
        severity: SEVERITY.HIGH,
        confidence: 68,
        title: 'High-value flow into elevated-risk jurisdiction',
        subject: highRisk.join(', '),
        rationale: `A high-value transaction (${round(value)}) involving elevated-risk jurisdiction(s) (${highRisk.join(', ')}) matches a trade-based money-laundering / sanctions-evasion pattern.`,
        evidence: [`value:${round(value)}`].concat(highRisk.map((c) => `high_risk:${c}`)),
        recommendation: 'File for enhanced AML review; verify source of funds and end-use.',
        refs: { value, jurisdictions: highRisk },
    });
}

// ── The default deterministic heuristic provider. ────────────────────────────
const heuristicProvider = Object.freeze({
    name: 'heuristic',
    async analyze({ subject = {} } = {}) {
        const detectors = [
            detectJurisdictionRisk,
            detectRouteAnomaly,
            detectValuationAnomaly,
            detectGoodsMisclassification,
            detectDocumentationGap,
            detectAmlPattern,
        ];
        const findings = [];
        for (const d of detectors) {
            const f = d(subject);
            if (f) findings.push(f);
        }
        const reasoning = findings.length
            ? `Heuristic risk model raised ${findings.length} probabilistic signal(s): ${findings.map((f) => f.category).join(', ')}.`
            : 'Heuristic risk model found no anomalies beyond the deterministic rule checks.';
        return { findings, reasoning };
    },
});

// ── Provider registry (the pluggable / mockable seam). ───────────────────────
let activeProvider = heuristicProvider;

function assertProvider(p) {
    if (!p || typeof p.analyze !== 'function' || typeof p.name !== 'string') {
        throw new Error('registerProvider(): provider must be { name: string, analyze: async fn }');
    }
}

/** Swap in a different AI risk provider (e.g. a real model or vendor API). */
function registerProvider(provider) {
    assertProvider(provider);
    activeProvider = provider;
    return activeProvider;
}

/** Reset to the built-in deterministic heuristic provider. */
function resetProvider() {
    activeProvider = heuristicProvider;
    return activeProvider;
}

function getProvider() {
    return activeProvider;
}

/** Defensively re-shape one provider finding so a plug-in can't crash the agent. */
function normalizeFinding(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!ALL_CATEGORIES.includes(raw.category)) return null;
    try {
        return finding({
            category: raw.category,
            source: SOURCE.AI, // re-stamp: this layer is always the AI source
            severity: raw.severity,
            confidence: raw.confidence,
            title: raw.title,
            subject: raw.subject,
            rationale: raw.rationale,
            evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
            recommendation: raw.recommendation,
            refs: raw.refs && typeof raw.refs === 'object' ? raw.refs : {},
        });
    } catch {
        return null;
    }
}

/**
 * Run the AI layer via the active provider. NEVER throws — a failing provider
 * degrades to zero findings + a degraded flag (fail-open is SAFE here: the AI
 * layer is advisory and the rule layer is the hard gate).
 *
 * @returns {Promise<{ provider, findings, reasoning, degraded? }>}
 */
async function analyze({ subject, signals = [], context = {} } = {}) {
    try {
        const result = await activeProvider.analyze({ subject, signals, context });
        const findings = Array.isArray(result && result.findings)
            ? result.findings.map(normalizeFinding).filter(Boolean)
            : [];
        return {
            provider: activeProvider.name,
            findings,
            reasoning: (result && result.reasoning) || '',
        };
    } catch (err) {
        return {
            provider: activeProvider.name,
            findings: [],
            reasoning: `AI risk provider '${activeProvider.name}' failed: ${err.message}`,
            degraded: true,
        };
    }
}

module.exports = {
    analyze,
    registerProvider,
    resetProvider,
    getProvider,
    normalizeFinding,
    heuristicProvider,
    // detectors exported for unit tests
    detectJurisdictionRisk,
    detectRouteAnomaly,
    detectValuationAnomaly,
    detectGoodsMisclassification,
    detectDocumentationGap,
    detectAmlPattern,
    HIGH_RISK_COUNTRIES,
    TRANSSHIPMENT_HUBS,
    CATEGORY_VALUE_BAND,
    SENSITIVE_CUES,
};
