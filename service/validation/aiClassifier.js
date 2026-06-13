'use strict';
/**
 * AI Document Validation Engine — pluggable AI CLASSIFICATION LAYER (Prompt 5).
 *
 * The classification layer answers two questions a pure rules engine can't:
 *   1. "What kind of document is this really?" — independent of the doc_type the
 *      uploader claimed. A declared `bill_of_lading` whose content reads as a
 *      `commercial_invoice` is a red flag the rules engine alone never sees.
 *   2. "Do any values look implausible / anomalous?" — negative quantities, zero
 *      weights, far-future dates: soft signals a learned model surfaces.
 *
 * It is PLUGGABLE by design. The default provider is a deterministic, network-free
 * HEURISTIC classifier (keyword + field-signal scoring) so the engine works
 * offline and tests stay reproducible. A real model — Claude, a fine-tuned
 * classifier, a vendor OCR/IDP service — is dropped in with `registerProvider()`
 * without touching the engine, rules, or report code.
 *
 * A provider MUST implement:
 *   {
 *     name: string,
 *     async classify({ document, extracted, context }) => {
 *       docType:      string|null,   // inferred type
 *       confidence:   0..100,        // confidence in docType
 *       fields?:      object,        // optionally enriched/extracted fields
 *       findings?:    finding[],     // schema.finding(... source:'ai')
 *     }
 *   }
 */

const { SEVERITY, CATEGORY, CODE, finding } = require('./schema');
const norm = require('./normalize');

// Keyword / field signals per document type. Each hit adds weight; the winning
// type's normalized score becomes the confidence.
const TYPE_SIGNALS = Object.freeze({
    commercial_invoice: {
        keywords: ['commercial invoice', 'invoice', 'bill to', 'sold to', 'terms of sale'],
        fields: ['invoice_number', 'unit_price', 'total_amount', 'currency'],
    },
    proforma_invoice: {
        keywords: ['proforma', 'pro forma', 'proforma invoice', 'quotation'],
        fields: ['invoice_number', 'total_amount'],
    },
    packing_list: {
        keywords: ['packing list', 'packing', 'gross weight', 'net weight', 'carton', 'pallet'],
        fields: ['gross_weight', 'net_weight', 'package_count'],
    },
    bill_of_lading: {
        keywords: ['bill of lading', 'b/l', 'shipped on board', 'port of loading', 'port of discharge', 'vessel'],
        fields: ['bl_number', 'port_of_loading', 'port_of_discharge', 'vessel'],
    },
    certificate_of_origin: {
        keywords: ['certificate of origin', 'country of origin', 'chamber of commerce', 'exporter'],
        fields: ['origin_country', 'exporter'],
    },
    customs_declaration: {
        keywords: ['customs', 'declaration', 'hs code', 'tariff', 'import', 'export entry'],
        fields: ['hs_code', 'origin_country', 'destination_country'],
    },
    insurance_certificate: {
        keywords: ['insurance', 'policy', 'insured amount', 'marine cover', 'underwriter'],
        fields: ['policy_number', 'insured_amount'],
    },
});

const LOW_CONFIDENCE_THRESHOLD = 45; // below this, classification is "unsure"
const MISMATCH_CONFIDENCE_GAP = 25;  // inferred must beat declared by this to flag

function textCorpus(document, extracted) {
    const parts = [
        document && document.title,
        document && document.doc_type,
        document && document.file_name,
        extracted && extracted.text,
        extracted && extracted.raw_text,
    ].filter(Boolean);
    // Fold in extracted field KEYS too — their presence is a structural signal.
    if (extracted) parts.push(Object.keys(extracted).join(' '));
    return parts.join(' \n ').toLowerCase();
}

/** Score every known type against the corpus + present fields. */
function scoreTypes(corpus, extracted) {
    const scores = {};
    for (const [type, sig] of Object.entries(TYPE_SIGNALS)) {
        let score = 0;
        for (const kw of sig.keywords) if (corpus.includes(kw)) score += 2;
        for (const f of sig.fields) if (extracted && !norm.isBlank(extracted[f])) score += 1.5;
        scores[type] = score;
    }
    return scores;
}

/** Soft plausibility checks a learned model would surface as anomalies. */
function plausibilityFindings(extracted, out) {
    if (!extracted) return;
    const qty = norm.toNumber(extracted.quantity);
    if (qty !== null && qty <= 0) {
        out.push(finding({
            code: CODE.IMPLAUSIBLE_VALUE, category: CATEGORY.INTEGRITY, severity: SEVERITY.HIGH,
            field: 'quantity', actual: extracted.quantity, confidence: 88, source: 'ai',
            message: 'Quantity is zero or negative — implausible for a shipped consignment',
        }));
    }
    const gross = norm.toGrams(extracted.gross_weight);
    const net = norm.toGrams(extracted.net_weight);
    if (gross !== null && net !== null && net > gross) {
        out.push(finding({
            code: CODE.IMPLAUSIBLE_VALUE, category: CATEGORY.INTEGRITY, severity: SEVERITY.MEDIUM,
            field: 'net_weight', expected: `≤ ${gross}g`, actual: `${net}g`, confidence: 85, source: 'ai',
            message: 'Net weight exceeds gross weight — physically impossible',
        }));
    }
    const total = norm.toNumber(extracted.total_amount);
    if (total !== null && total < 0) {
        out.push(finding({
            code: CODE.IMPLAUSIBLE_VALUE, category: CATEGORY.INTEGRITY, severity: SEVERITY.HIGH,
            field: 'total_amount', actual: total, confidence: 88, source: 'ai',
            message: 'Total amount is negative',
        }));
    }
}

/**
 * The default, deterministic heuristic provider. Network-free and reproducible.
 */
const heuristicProvider = Object.freeze({
    name: 'heuristic',
    async classify({ document = {}, extracted = {} } = {}) {
        const corpus = textCorpus(document, extracted);
        const scores = scoreTypes(corpus, extracted);

        let best = null;
        let bestScore = 0;
        let total = 0;
        for (const [type, score] of Object.entries(scores)) {
            total += score;
            if (score > bestScore) { bestScore = score; best = type; }
        }

        // Confidence = winner's share of total signal, scaled — bounded so a lone
        // weak signal never reads as certain.
        let confidence = 0;
        if (best && total > 0) {
            const share = bestScore / total;
            confidence = Math.round(Math.min(100, share * 100 * Math.min(1, bestScore / 4)));
        }

        const findings = [];

        if (!best || confidence < LOW_CONFIDENCE_THRESHOLD) {
            findings.push(finding({
                code: best ? CODE.LOW_CONFIDENCE_EXTRACTION : CODE.UNCLASSIFIED_DOCUMENT,
                category: CATEGORY.CLASSIFICATION,
                severity: best ? SEVERITY.LOW : SEVERITY.MEDIUM,
                field: 'doc_type', expected: document.doc_type || null, actual: best,
                confidence: best ? 60 : 75, source: 'ai',
                message: best
                    ? `Document type inferred as '${best}' but with low confidence (${confidence})`
                    : 'Document content did not match any known trade-document type',
            }));
        }

        // Declared-vs-inferred mismatch: only flag when the model is confident AND
        // clearly disagrees with the uploader's declared type.
        const declared = document.doc_type || null;
        if (best && declared && best !== declared && confidence >= LOW_CONFIDENCE_THRESHOLD + MISMATCH_CONFIDENCE_GAP) {
            findings.push(finding({
                code: CODE.DOC_TYPE_MISMATCH, category: CATEGORY.CLASSIFICATION, severity: SEVERITY.HIGH,
                field: 'doc_type', expected: declared, actual: best, confidence, source: 'ai',
                message: `Declared as '${declared}' but content classifies as '${best}'`,
            }));
        }

        plausibilityFindings(extracted, findings);

        return { docType: best, confidence, fields: {}, findings };
    },
});

// ── Provider registry (the pluggable seam). ──────────────────────────────────
let activeProvider = heuristicProvider;

function assertProvider(p) {
    if (!p || typeof p.classify !== 'function' || typeof p.name !== 'string') {
        throw new Error('registerProvider(): provider must be { name: string, classify: async fn }');
    }
}

/** Swap in a different classification provider (e.g. an LLM-backed one). */
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

/**
 * Classify a document with the active provider, defensively normalizing the
 * result so a misbehaving plug-in can never crash the engine.
 */
async function classify(input) {
    let result;
    try {
        result = await activeProvider.classify(input || {});
    } catch (err) {
        return {
            docType: null,
            confidence: 0,
            fields: {},
            findings: [finding({
                code: CODE.UNCLASSIFIED_DOCUMENT, category: CATEGORY.CLASSIFICATION, severity: SEVERITY.LOW,
                field: 'doc_type', confidence: 50, source: 'ai',
                message: `Classification provider '${activeProvider.name}' failed: ${err.message}`,
            })],
            provider: activeProvider.name,
            degraded: true,
        };
    }
    return {
        docType: result.docType ?? null,
        confidence: Math.max(0, Math.min(100, Math.round(result.confidence ?? 0))),
        fields: result.fields || {},
        findings: Array.isArray(result.findings) ? result.findings : [],
        provider: activeProvider.name,
        degraded: false,
    };
}

module.exports = {
    classify,
    registerProvider,
    resetProvider,
    getProvider,
    heuristicProvider,
    TYPE_SIGNALS,
    LOW_CONFIDENCE_THRESHOLD,
};
